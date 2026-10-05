// Runs htmlToMarkdown off the main thread. The conversion is bounded (html.ts), but it's still up to a few seconds
// of synchronous work on a page someone else wrote; on the main thread that would freeze the TUI, and ctrl+c and
// the fetch's timeout with it, since neither can interrupt a running function. A Worker can be terminated at any
// point, so a page that takes too long is cut off and its plain text used instead.
//
// One worker per page: starting one costs ~50 ms (loading linkedom, Readability and turndown), little next to the
// download, and a fresh one can't carry anything over from the last page (or its memory: a 5 MB page can take 1-2 GB
// while it's converted, given back when the worker ends).
import type { Markdown } from "./html.ts";
import type { Reply, Request } from "./html-worker.ts";
import { plainText } from "./plain.ts";

/** A bounded conversion takes ~3 s at worst (5 MB of tables) on a fast machine; this leaves room for a slow one. */
export const CONVERT_TIMEOUT_MS = 15_000;

export interface ConvertOptions {
  /** The call's abort signal (ctrl+c): the worker is stopped and the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** After this long the worker is stopped and the page's plain text is returned instead (`plain: true`). */
  timeoutMs?: number;
}

/** htmlToMarkdown in a Worker. Resolves with the Markdown, or with the page's plain text (`plain: true`) if converting
 *  timed out or failed; rejects only if the signal aborts or the worker itself can't run. */
export function convertHtml(html: string, url: string, { signal, timeoutMs = CONVERT_TIMEOUT_MS }: ConvertOptions = {}): Promise<Markdown> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<Markdown>((resolve, reject) => {
    // Bun runs a .ts worker as it is (no build step); the URL is relative to this file, so it works from any cwd.
    const worker = new Worker(new URL("./html-worker.ts", import.meta.url));
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate(); // always: a worker left running would keep its thread and memory
      settle();
    };
    const onAbort = () => finish(() => reject(signal!.reason));
    const timer = setTimeout(() => finish(() => resolve(plainText(html))), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      finish(() => resolve(reply.ok ? reply.result : plainText(html)));
    };
    // The worker failed to load or crashed outside the conversion: a bug in Marv, not the page, so it's reported.
    worker.onerror = (event: ErrorEvent) => finish(() => reject(new Error(`couldn't convert the page: ${event.message}`)));
    worker.postMessage({ html, url } satisfies Request);
  });
}
