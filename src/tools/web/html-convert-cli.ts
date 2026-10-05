// The converter process that convertHtml (convert.ts) starts for each page. It reads `{ html, url }` as JSON on stdin,
// runs htmlToMarkdown, and writes a Reply as JSON on stdout, then exits.
//
// Why a process and not a Worker: htmlToMarkdown is synchronous CPU work on a stranger's HTML, and the only way to
// stop it midway is from outside. Bun's `worker.terminate()` doesn't interrupt JavaScript that's already running
// (measured in 1.3.11: a terminated worker kept a core busy for 15 s and grew to 2.4 GB), while the OS always
// stops a process on SIGKILL, and takes back all its memory.
import { htmlToMarkdown } from "./html.ts";

export interface Request {
  html: string;
  url: string;
}
export type Reply = { ok: true; result: ReturnType<typeof htmlToMarkdown> } | { ok: false; error: string };

let reply: Reply;
try {
  const { html, url } = JSON.parse(await Bun.stdin.text()) as Request;
  reply = { ok: true, result: htmlToMarkdown(html, url) };
} catch (error) {
  // A conversion that fails (a stack overflow, a library bug on odd markup) is an answer, not a crash: the page was
  // downloaded fine, and convertHtml can still give its text.
  reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
}
await Bun.write(Bun.stdout, JSON.stringify(reply));
