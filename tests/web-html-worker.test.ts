import { expect, test } from "bun:test";
import { convertHtml } from "../src/tools/web/convert.ts";
import { htmlToMarkdown } from "../src/tools/web/html.ts";
import { MAX_CHARS, plainText } from "../src/tools/web/plain.ts";

const MB = 1024 * 1024;
const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt. ";
const fill = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));
const page = (body: string) => `<!doctype html><html><head><title>Big</title></head><body>${body}</body></html>`;

/** Runs `work` while a 10 ms interval ticks, and returns its result and the longest gap between ticks: if the main
 *  thread were busy converting, the interval couldn't fire. */
async function whileTicking<T>(work: () => Promise<T>): Promise<{ result: T; ms: number; longestGap: number }> {
  let last = performance.now();
  let longestGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longestGap = Math.max(longestGap, now - last);
    last = now;
  }, 10);
  const start = performance.now();
  try {
    const result = await work();
    return { result, ms: performance.now() - start, longestGap: Math.max(longestGap, performance.now() - last) };
  } finally {
    clearInterval(timer);
  }
}

test("converts in a worker, with the same result as htmlToMarkdown", async () => {
  const html = page(`<nav>Menu</nav><article><h1>Title</h1><p>${LOREM.repeat(4)} <a href="/x">x</a></p></article>`);
  expect(await convertHtml(html, "https://e.com/")).toEqual(htmlToMarkdown(html, "https://e.com/"));
});

test("an ordinary 200 KB page converts in well under a second", async () => {
  const article = fill(`<h2>Section</h2><p>${LOREM}<a href="/more">more</a> <code>x</code></p><ul><li>${LOREM}</li></ul>\n`, 200 * 1024);
  const html = page(`<header><nav><a href="/">Home</a></nav></header><main><article>${article}</article></main><footer>(c)</footer>`);
  const { result, ms } = await whileTicking(() => convertHtml(html, "https://e.com/"));
  expect(result.plain).toBeFalsy();
  expect(result.fallback).toBe(false);
  expect(ms).toBeLessThan(1000); // measured ~250 ms, worker start included
});

for (const [name, html] of [
  ["5 MB of links", page(`<ul>${fill(`<li><a href="/p/x?q=1">item link</a></li>`, 5 * MB)}</ul>`)],
  ["2,000 nested divs", page(`${"<div>".repeat(2000)}${LOREM}${"</div>".repeat(2000)}`)],
] as const) {
  test(`${name}: converted (or given as plain text) in time, without blocking the main thread`, async () => {
    const { result, ms, longestGap } = await whileTicking(() => convertHtml(html, "https://e.com/", { timeoutMs: 10_000 }));
    expect(ms).toBeLessThan(11_000);
    expect(longestGap).toBeLessThan(300); // the main thread stayed free (unbounded, on it: 280 s and 23 s)
    expect(result.markdown.length).toBeGreaterThan(0);
    expect(result.markdown.length).toBeLessThan(MAX_CHARS * 1.3);
  }, 20_000);
}

test("too slow: the worker is stopped and the page's plain text comes back", async () => {
  const html = page(`<script>var secret = 1;</script><p hidden>HIDDEN</p><p>Visible &amp; <b>kept</b></p>${fill(`<li><a href="/p">x</a></li>`, 2 * MB)}`);
  const result = await convertHtml(html, "https://e.com/", { timeoutMs: 1 });
  expect(result.plain).toBe(true);
  expect(result.fallback).toBe(true);
  expect(result.title).toBe("Big");
  expect(result.markdown).toStartWith("Visible & kept");
  expect(result.markdown).not.toContain("secret");
  expect(result.markdown).not.toContain("HIDDEN");
});

test("aborting stops the conversion and rejects with the signal's reason", async () => {
  const html = page(fill(`<li><a href="/p">x</a></li>`, 5 * MB));
  const controller = new AbortController();
  const reason = new Error("stopped by the user");
  const pending = convertHtml(html, "https://e.com/", { signal: controller.signal });
  setTimeout(() => controller.abort(reason), 20);
  const start = performance.now();
  await expect(pending).rejects.toBe(reason);
  expect(performance.now() - start).toBeLessThan(500); // right away, not when the conversion would have finished
  await expect(convertHtml(html, "https://e.com/", { signal: controller.signal })).rejects.toBe(reason); // already aborted
});

test("plainText drops tags, scripts, styles, comments and hidden elements, and decodes entities", () => {
  const html = `<!doctype html><html><head><title>A &amp; B\nC</title><style>p { color: red }</style></head><body>
<!-- a comment --><h1>Head</h1><p>One &lt;two&gt; &#51; &#x34; &nbsp;five</p>
<div style="display:none">HIDDEN-STYLE<div>still hidden</div></div><p aria-hidden="true">HIDDEN-ARIA</p><img hidden src="x">
<select><option>OPT</option></select><script>evil()</script><svg><text>SVG</text></svg>
<ul><li>first</li><li>second</li></ul><table><tr><td>a</td><td>b</td></tr></table>a < b</body></html>`;
  const { title, markdown, plain } = plainText(html);
  expect(plain).toBe(true);
  expect(title).toBe("A & B C");
  expect(markdown).toBe("Head\n\nOne <two> 3 4 five\n\nfirst\n\nsecond\n\na b\n\na < b"); // blocks a blank line apart, like paragraphs
});

test("plainText stops at the budget and says so", () => {
  const { markdown, truncated } = plainText(`<p>${"word ".repeat(1000)}</p>`, 100);
  expect(markdown.length).toBeLessThanOrEqual(100);
  expect(truncated).toBe(true);
  expect(plainText("<p>short</p>", 100).truncated).toBeUndefined();
});

test("plainText stays linear on input built to make a scanner backtrack", () => {
  for (const html of [
    "<script".repeat(200_000),
    "<select>".repeat(200_000),
    "<div hidden>".repeat(200_000),
    "</script ".repeat(200_000) + "<script>",
    "<a<b<c".repeat(200_000),
    "<!--".repeat(200_000),
    `<p style="${";display:none ".repeat(100_000)}x">`,
  ]) {
    const start = performance.now();
    plainText(html);
    expect(performance.now() - start).toBeLessThan(500);
  }
});
