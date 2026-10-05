// The Worker that convertHtml (convert.ts) starts for each page: htmlToMarkdown is synchronous CPU work on a stranger's
// HTML, and here it runs on its own thread, so the UI keeps drawing, ctrl+c still works, and a page that takes too
// long can be stopped (the main thread terminates the worker; a function call couldn't be interrupted).
import { htmlToMarkdown } from "./html.ts";

declare const self: Worker;

export interface Request {
  html: string;
  url: string;
}
export type Reply = { ok: true; result: ReturnType<typeof htmlToMarkdown> } | { ok: false; error: string };

self.onmessage = (event: MessageEvent<Request>) => {
  const { html, url } = event.data;
  let reply: Reply;
  try {
    reply = { ok: true, result: htmlToMarkdown(html, url) };
  } catch (error) {
    // A conversion that fails (a stack overflow, a library bug on odd markup) is an answer, not a crash: the
    // page was downloaded fine, and convertHtml can still give its text.
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(reply);
};
