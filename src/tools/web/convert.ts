// Runs htmlToMarkdown in a separate process. The conversion is bounded (html.ts), but it's still seconds of synchronous
// work on a page someone else wrote; on the main thread that would freeze the TUI, and ctrl+c and the fetch's timeout
// with it, since neither can interrupt a running function. A process can be killed at any point, so a page that takes
// too long is cut off and its plain text used instead. (A Worker can't: see html-convert-cli.ts.)
//
// One process per page: starting one costs ~90 ms (Bun, then linkedom, Readability and turndown), little next to the
// download, and a fresh one carries nothing over from the last page, and gives all its memory back when it ends
// (a 5 MB page can take a gigabyte while it's converted).
import type { Subprocess } from "bun";
import { fileURLToPath } from "node:url";
import type { Markdown } from "./html.ts";
import type { Reply, Request } from "./html-convert-cli.ts";
import { plainText } from "./plain.ts";

/** The slowest bounded conversion measured takes ~5.5 s on a fast machine (5 MB of <hr>: parsing 1.3M elements is most
 *  of it); this leaves room for a slower or busy one. */
export const CONVERT_TIMEOUT_MS = 15_000;

// fileURLToPath, not `.pathname`: that keeps %20 for a space in the path, and the file wouldn't be found.
const CONVERTER = fileURLToPath(new URL("./html-convert-cli.ts", import.meta.url));
const CONVERTER_DIR = fileURLToPath(new URL(".", import.meta.url));

export interface ConvertOptions {
  /** The call's abort signal (ctrl+c): the converter is killed and the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** After this long the converter is killed and the page's plain text is returned instead (`plain: true`). */
  timeoutMs?: number;
}

let lastPid: number | undefined;
/** For tests: the pid of the converter the last convertHtml started, to check it's really gone. */
export const lastConverterPid = () => lastPid;

/** htmlToMarkdown in its own process. Resolves with the Markdown, or with the page's plain text (`plain: true`,
 *  `reason` "timeout" or "error") if converting took too long or failed; rejects only if the signal aborts or the
 *  process can't be started. Either way the process has exited by the time the promise settles. */
export function convertHtml(html: string, url: string, { signal, timeoutMs = CONVERT_TIMEOUT_MS }: ConvertOptions = {}): Promise<Markdown> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let child: Subprocess<Blob, "pipe", "ignore">;
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", CONVERTER], {
      // Not the project's folder: Bun would read its bunfig.toml (which can preload code) and .env.
      cwd: CONVERTER_DIR,
      // Nothing from Marv's environment: the page decides what this process does, and API keys have no business there.
      env: {},
      stdin: new Blob([JSON.stringify({ html, url } satisfies Request)]),
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (error) {
    return Promise.reject(error);
  }
  lastPid = child.pid;

  return new Promise<Markdown>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.kill("SIGKILL"); // always, and only settle once it's gone: nothing is left running, or using memory
      void child.exited.then(settle, settle);
    };
    const fallback = (reason: "timeout" | "error") => () => resolve({ ...plainText(html), reason });
    const onAbort = () => finish(() => reject(signal!.reason));
    const timer = setTimeout(() => finish(fallback("timeout")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    // stdout closes when the converter exits. A reply that isn't one (it crashed, was killed for memory) means the
    // conversion failed: the plain text is given right away rather than after the timeout.
    new Response(child.stdout).text().then(
      (out) => {
        const reply = parseReply(out);
        finish(reply?.ok ? () => resolve(reply.result) : fallback("error"));
      },
      () => finish(fallback("error")),
    );
  });
}

function parseReply(out: string): Reply | undefined {
  try {
    const reply = JSON.parse(out) as Reply;
    return reply && typeof reply === "object" && (reply.ok === false || typeof reply.result?.markdown === "string") ? reply : undefined;
  } catch {
    return undefined;
  }
}
