// Downloading for web_fetch: plain GETs only (the model chooses the URL, nothing else), each redirect checked
// again (a public page could redirect to a private address), with a time and a size limit, text only.
import { brotliDecompressSync, constants, gunzipSync, inflateSync } from "node:zlib";
import { looksBinary } from "../files.ts";
import { ToolError } from "../types.ts";
import { checkAddress } from "./address.ts";
import { convertHtml } from "./convert.ts";
import type { FallbackReason } from "./html.ts";
import { MAX_CHARS } from "./plain.ts";

export const TIMEOUT_MS = 20_000;
export const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "Marv (a terminal coding agent)";
// Some sites send Markdown when asked for it, which beats converting their HTML.
const ACCEPT = "text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.5";
const ERROR_BODY_BYTES = 64 * 1024; // an error page: enough for its message, never worth failing over
const TEXT = /^text\/|json|xml|javascript|markdown|yaml|toml|vnd\.github/;

export interface GetOptions {
  signal?: AbortSignal;
  /** Tests only: let a local server through the address check. */
  allowPrivate?: boolean;
  /** Sent to the first URL's host only: a token mustn't follow a redirect to another site. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface Got {
  /** Where it ended up, after redirects. */
  url: string;
  status: number;
  statusText: string;
  headers: Headers;
  body: string;
}

/** What web_fetch shows the model. */
export interface Page {
  url: string;
  title?: string;
  text: string;
  /** Said under the header, e.g. that Readability found nothing. */
  note?: string;
}

/** The model's URL as a URL: without a scheme ("github.com/o/r"), https is meant. */
export function parseUrl(text: string): URL {
  text = text.trim();
  // "example.com:8080/x" and "localhost:3000" are hosts with a port, not schemes: only "://" or a known
  // scheme without slashes counts, so they become https URLs (and the address check then judges them).
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(mailto|file|data|javascript):/i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withScheme);
  } catch {
    throw new ToolError(`Not a valid URL: ${text}. Give the full address, e.g. https://example.com/page.`);
  }
}

/** Why the model sees something other than the page's main content as Markdown. */
const FALLBACK_NOTES: Record<FallbackReason, string> = {
  "no-article": "No main content found (the page may be built by JavaScript): this is the whole page.",
  "too-large": "The page is too big to pick out its main content: this is the whole page.",
  "too-deep": "The page is too deeply nested to pick out its main content: this is the whole page.",
  timeout: "The page took too long to convert: this is its plain text.",
  error: "The page couldn't be converted: this is its plain text.",
};

export const httpError = (got: Got) => new ToolError(`${got.status} ${got.statusText || "error"} at ${got.url}.`);

/** Credentials go only where the user's URL pointed, and only over https: `URL.host` ignores the scheme, so a
 * redirect from https to http on the same host would otherwise send a token in clear. */
export const sendsHeaders = (first: URL, current: URL) => current.origin === first.origin && current.protocol === "https:";

/** GETs a URL, following redirects by hand so each one is checked. Error statuses are returned, not thrown: the caller knows what they mean. */
export async function get(url: string, options: GetOptions = {}): Promise<Got> {
  const { timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const first = parseUrl(url);
  let current = first;
  try {
    for (let redirects = 0; ; redirects++) {
      await checkAddress(current, { ...options, signal }); // the lookup counts toward the time limit and stops on abort
      if (current.protocol !== "http:" && current.protocol !== "https:") throw new ToolError(`Refused: ${current.href} is not an http(s) address.`);
      const headers = { "user-agent": USER_AGENT, accept: ACCEPT, "accept-encoding": "gzip, deflate, br", ...(sendsHeaders(first, current) ? options.headers : {}) };
      // Ours to abort once this response is dealt with. Merely leaving a body unread doesn't close the
      // connection (a server kept sending 27 GB until the timeout), so we cut it. It only ever happens after
      // the outcome is decided, so it can't be mistaken for the user's abort or a timeout.
      const ours = new AbortController();
      try {
        // decompress: false: Bun would inflate before we read and keep going after we stop (6.5 KB of brotli
        // became 8 GB of memory). We read the compressed bytes under the cap and inflate them ourselves, bounded.
        const response = await fetch(current, { headers, redirect: "manual", signal: AbortSignal.any([signal, ours.signal]), decompress: false } as RequestInit);
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          if (redirects === MAX_REDIRECTS) throw new ToolError(`Too many redirects (more than ${MAX_REDIRECTS}) from ${url}.`);
          current = new URL(location, current);
          continue;
        }
        const type = (response.headers.get("content-type") ?? "").toLowerCase();
        if (response.ok && type && !TEXT.test(type)) {
          throw new ToolError(`${current.href} is ${type.split(";")[0]}, not text: web_fetch reads pages and text files only.`);
        }
        const body = await readText(response, maxBytes, current.href, type);
        return { url: current.href, status: response.status, statusText: response.statusText, headers: response.headers, body };
      } finally {
        ours.abort();
      }
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (timeout.aborted) throw new ToolError(`Timed out after ${timeoutMs / 1000} s fetching ${current.href}.`);
    if (options.signal?.aborted) throw err; // the user stopped the run: not the site's fault
    throw new ToolError(`Couldn't fetch ${current.href}: ${(err as Error).message}`);
  }
}

/** A page as text: HTML converted to Markdown, other text as it is. */
export async function fetchPage(url: string, options: GetOptions = {}): Promise<Page> {
  const got = await get(url, options);
  if (got.status < 200 || got.status >= 300) throw httpError(got);
  const type = (got.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("html") || (!type && /^\s*<(!doctype html|html)/i.test(got.body))) {
    // In a subprocess, with its own time limit: converting a big or hostile page can take seconds of CPU, which
    // on the main thread would freeze the whole UI (ctrl+c included).
    const { title, markdown, reason, truncated } = await convertHtml(got.body, got.url, { signal: options.signal });
    const notes = [reason && FALLBACK_NOTES[reason], truncated && `Cut at ${MAX_CHARS.toLocaleString("en")} characters.`].filter(Boolean);
    return { url: got.url, title, text: markdown, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }
  return { url: got.url, text: got.body };
}

async function readText(response: Response, maxBytes: number, url: string, type: string): Promise<string> {
  const limit = maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes} bytes`;
  const tooLarge = () => new ToolError(`${url} is larger than ${limit}, the most web_fetch reads.`);
  // An error page only needs its start: read a little and cut, instead of failing on a big one.
  const ok = response.ok;
  const cap = ok ? maxBytes : Math.min(maxBytes, ERROR_BODY_BYTES);
  if (ok && Number(response.headers.get("content-length")) > cap) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (ok && size > cap) throw tooLarge(); // leaving the loop cancels the stream
      chunks.push(chunk);
      if (size > cap) break; // an error page: the start is enough (cut to size below)
    }
  }
  let bytes: Uint8Array = Buffer.concat(chunks);
  const encoding = (response.headers.get("content-encoding") ?? "").trim().toLowerCase();
  try {
    bytes = inflate(bytes, encoding, maxBytes, !ok);
  } catch (err) {
    if (err instanceof ToolError) throw err;
    const code = (err as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
      if (ok) throw tooLarge();
      bytes = new Uint8Array(0);
    } else if (ok) {
      throw new ToolError(`Couldn't fetch ${url}: the response is damaged.`);
    } else {
      bytes = new Uint8Array(0);
    }
  }
  if (!ok && bytes.length > ERROR_BODY_BYTES) bytes = bytes.subarray(0, ERROR_BODY_BYTES);
  if (looksBinary(bytes)) {
    if (ok) throw new ToolError(`${url} looks like a binary file, not text.`);
    return "";
  }
  return decoder(type, bytes).decode(bytes);
}

/** Undoes Content-Encoding with a cap on the output, so a small download can't expand into gigabytes. `partial`: the input may be cut short (an error page's start). */
function inflate(bytes: Uint8Array, encoding: string, maxOutputLength: number, partial: boolean): Uint8Array {
  const flush = partial ? { finishFlush: constants.Z_SYNC_FLUSH } : {};
  switch (encoding) {
    case "":
    case "identity":
      return bytes;
    case "gzip":
    case "x-gzip":
      return gunzipSync(bytes, { maxOutputLength, ...flush });
    case "deflate":
      return inflateSync(bytes, { maxOutputLength, ...flush });
    case "br":
      return brotliDecompressSync(bytes, { maxOutputLength, ...(partial ? { finishFlush: constants.BROTLI_OPERATION_FLUSH } : {}) });
    default:
      throw new ToolError(`The server answered with an encoding web_fetch can't read (${encoding}).`);
  }
}

function decoder(type: string, bytes: Uint8Array): TextDecoder {
  let charset = /charset=["']?([\w-]+)/i.exec(type)?.[1];
  if (!charset && type.includes("html")) {
    // No charset in the header: pages say it in a <meta> near the top.
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder((charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]); // unknown names throw, caught below
  } catch {
    return new TextDecoder(); // a charset TextDecoder doesn't know: utf-8 is the best guess
  }
}
