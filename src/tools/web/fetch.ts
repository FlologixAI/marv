// Downloading for web_fetch: plain GETs only (the model chooses the URL, nothing else), each redirect checked
// again (a public page could redirect to a private address), with a time and a size limit, text only.
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
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
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
      const headers = { "user-agent": USER_AGENT, accept: ACCEPT, ...(current.host === first.host ? options.headers : {}) };
      const response = await fetch(current, { headers, redirect: "manual", signal });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (redirects === MAX_REDIRECTS) throw new ToolError(`Too many redirects (more than ${MAX_REDIRECTS}) from ${url}.`);
        current = new URL(location, current);
        continue;
      }
      const type = response.headers.get("content-type") ?? "";
      if (response.ok && type && !TEXT.test(type)) {
        await response.body?.cancel();
        throw new ToolError(`${current.href} is ${type.split(";")[0]}, not text: web_fetch reads pages and text files only.`);
      }
      const body = await readText(response, maxBytes, current.href);
      return { url: current.href, status: response.status, statusText: response.statusText, headers: response.headers, body };
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
  const type = got.headers.get("content-type") ?? "";
  if (type.includes("html") || (!type && /^\s*<(!doctype html|html)/i.test(got.body))) {
    // In a worker, with its own time limit: converting a big or hostile page can take seconds of CPU, which
    // on the main thread would freeze the whole UI (ctrl+c included).
    const { title, markdown, reason, truncated } = await convertHtml(got.body, got.url, { signal: options.signal });
    const notes = [reason && FALLBACK_NOTES[reason], truncated && `Cut at ${MAX_CHARS.toLocaleString("en")} characters.`].filter(Boolean);
    return { url: got.url, title, text: markdown, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }
  return { url: got.url, text: got.body };
}

async function readText(response: Response, maxBytes: number, url: string): Promise<string> {
  const limit = maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes} bytes`;
  const tooLarge = () => new ToolError(`${url} is larger than ${limit}, the most web_fetch reads.`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw tooLarge(); // leaving the loop cancels the stream
      chunks.push(chunk);
    }
  }
  const bytes = Buffer.concat(chunks);
  if (looksBinary(bytes)) throw new ToolError(`${url} looks like a binary file, not text.`);
  return decoder(response.headers.get("content-type")).decode(bytes);
}

function decoder(type: string | null): TextDecoder {
  const charset = /charset=["']?([\w-]+)/i.exec(type ?? "")?.[1];
  try {
    return new TextDecoder((charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]); // unknown names throw, caught below
  } catch {
    return new TextDecoder(); // a charset TextDecoder doesn't know: utf-8 is the best guess
  }
}
