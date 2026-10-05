// convertHtml runs the conversion in a separate process; plainText is its fallback. These tests check behavior, not
// speed: a loaded machine can be ten times slower, so time limits are ~10x what was measured, and the fallback is
// tested with a timeout too short for any conversion.
import { expect, test } from "bun:test";
import { convertHtml, lastConverterPid } from "../src/tools/web/convert.ts";
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

/** Whether a process with this pid exists (signal 0 checks without sending anything). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("converts in its own process, with the same result as htmlToMarkdown", async () => {
  const html = page(`<nav>Menu</nav><article><h1>Title</h1><p>${LOREM.repeat(4)} <a href="/x">x</a></p></article>`);
  expect(await convertHtml(html, "https://e.com/")).toEqual(htmlToMarkdown(html, "https://e.com/"));
  expect(alive(lastConverterPid()!)).toBe(false); // it exited
}, 30_000);

test("an ordinary 200 KB page is converted, not given up on", async () => {
  const article = fill(`<h2>Section</h2><p>${LOREM}<a href="/more">more</a> <code>x</code></p><ul><li>${LOREM}</li></ul>\n`, 200 * 1024);
  const html = page(`<header><nav><a href="/">Home</a></nav></header><main><article>${article}</article></main><footer>(c)</footer>`);
  const { result, ms } = await whileTicking(() => convertHtml(html, "https://e.com/"));
  expect(result.plain).toBeFalsy();
  expect(result.fallback).toBe(false);
  expect(ms).toBeLessThan(5000); // measured ~0.4 s, process start included
}, 30_000);

for (const [name, html] of [
  ["5 MB of links", page(`<ul>${fill(`<li><a href="/p/x?q=1">item link</a></li>`, 5 * MB)}</ul>`)],
  ["2,000 nested divs", page(`${"<div>".repeat(2000)}${LOREM}${"</div>".repeat(2000)}`)],
  ["5 MB of <br>", page(`<div>${fill("<br>", 5 * MB)}</div>`)],
] as const) {
  test(`${name}: converted or given as plain text, without blocking the main thread`, async () => {
    const { result, longestGap } = await whileTicking(() => convertHtml(html, "https://e.com/", { timeoutMs: 20_000 }));
    expect(longestGap).toBeLessThan(1000); // the main thread stayed free (unbounded, on it: 280 s and 23 s)
    expect(result.markdown.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(alive(lastConverterPid()!)).toBe(false);
  }, 60_000);
}

test("too slow: the converter is killed and the page's plain text comes back", async () => {
  const html = page(`<script>var secret = 1;</script><p hidden>HIDDEN</p><p>Visible &amp; <b>kept</b></p>${fill(`<li><a href="/p">x</a></li>`, 2 * MB)}`);
  const result = await convertHtml(html, "https://e.com/", { timeoutMs: 1 });
  expect(result).toMatchObject({ plain: true, fallback: true, reason: "timeout", title: "Big" });
  expect(result.markdown).toStartWith("Visible & kept");
  expect(result.markdown).not.toContain("secret");
  expect(result.markdown).not.toContain("HIDDEN");
  expect(alive(lastConverterPid()!)).toBe(false); // gone by the time the promise settled, not merely told to stop
}, 30_000);

test("aborting kills the converter and rejects with the signal's reason", async () => {
  const html = page(fill(`<li><a href="/p">x</a></li>`, 5 * MB));
  const controller = new AbortController();
  const reason = new Error("stopped by the user");
  const pending = convertHtml(html, "https://e.com/", { signal: controller.signal });
  setTimeout(() => controller.abort(reason), 20);
  await expect(pending).rejects.toBe(reason);
  expect(alive(lastConverterPid()!)).toBe(false);
  const pid = lastConverterPid();
  await expect(convertHtml(html, "https://e.com/", { signal: controller.signal })).rejects.toBe(reason); // already aborted
  expect(lastConverterPid()).toBe(pid); // nothing was started
}, 30_000);

test("plainText drops tags, scripts, styles, comments and hidden elements, and decodes entities", () => {
  const html = `<!doctype html><html><head><title>A &amp; B\nC</title><style>p { color: red }</style></head><body>
<!-- a comment --><h1>Head</h1><p>One &lt;two&gt; &#51; &#x34; &nbsp;five</p>
<div style="display:none">HIDDEN-STYLE<div>still hidden</div></div><p aria-hidden="true">HIDDEN-ARIA</p><img hidden src="x">
<select><option>OPT</option></select><script>evil()</script><svg><text>SVG</text></svg>
<ul><li>first</li><li>second</li></ul><p>x<br>y</p><table><tr><td>a</td><td>b</td></tr></table>a < b</body></html>`;
  const { title, markdown, plain } = plainText(html);
  expect(plain).toBe(true);
  expect(title).toBe("A & B C");
  expect(markdown).toBe("Head\n\nOne <two> 3 4 five\n\nfirst\n\nsecond\n\nx\ny\n\na b\n\na < b");
});

test("plainText reads quoted attributes as a browser does, so '>' in one doesn't end the tag", () => {
  expect(plainText(`<div title="x>" hidden>SECRET</div>visible`).markdown).toBe("visible");
  expect(plainText(`<img alt="x > y" src="/a.png"> visible`).markdown).toBe("visible");
  expect(plainText(`<div data-x='a"' hidden=hidden>H</div><div aria-hidden=TRUE>A</div>ok`).markdown).toBe("ok");
  expect(plainText(`text <div title="never closed>hidden</div> more`).markdown).toBe("text"); // the rest is inside the tag
});

test("plainText: hidden styles however they're written, and a hidden <p> ends where a block starts", () => {
  const styles = ["display:none", "DISPLAY: NONE !important", "opacity:0.0", "opacity: .0", "font-size:0px", "visibility : hidden", "display:none&#59;", "display:/**/none", "display:block;display:none"];
  const html = styles.map((style, i) => `<span style="${style}">H${i}</span>`).join("") + `<span style="opacity:0.01">shown</span>`;
  expect(plainText(html).markdown).toBe("shown");
  expect(plainText(`<p hidden>secret<p>visible one<p>visible two`).markdown).toBe("visible one\n\nvisible two");
});

test("plainText decodes the common named entities", () => {
  expect(plainText(`Caf&eacute; &mdash; &rsquo;quoted&rsquo; &ldquo;q&rdquo; &copy; 2026&hellip; &#39 &unknown;`).markdown).toBe(
    "Café — ’quoted’ “q” © 2026… ' &unknown;",
  );
});

test("plainText collapses whitespace before it counts toward the budget, and stops at it", () => {
  expect(plainText(`${" ".repeat(400_000)}<p>real content</p>`).markdown).toBe("real content");
  expect(plainText(`${"<div> </div>".repeat(60_000)}<p>real content</p>`).markdown).toBe("real content");
  const { markdown, truncated } = plainText(`<p>${"word ".repeat(1000)}</p>`, 100);
  expect(markdown.length).toBeLessThanOrEqual(100);
  expect(truncated).toBe(true);
  expect(plainText("<p>short</p>", 100).truncated).toBeUndefined();
});

test("plainText stays linear on input built to make a scanner backtrack", () => {
  /** The fastest of three runs, so a GC pause doesn't count. */
  const time = (html: string) => Math.min(...[0, 1, 2].map(() => {
    const start = performance.now();
    plainText(html);
    return performance.now() - start;
  }));
  for (const unit of ["<script", "<select>", "<div hidden>", "</script ", "<a<b<c", "<!--", "<x y='", "<a ", "<b hidden></b>", "&amp;", "<p style='/*/*/*'>"]) {
    const n = 100_000;
    const once = time(unit.repeat(n));
    const twice = time(unit.repeat(2 * n));
    expect(twice).toBeLessThan(once * 3 + 50); // linear doubles; quadratic would quadruple (and take seconds)
  }
});
