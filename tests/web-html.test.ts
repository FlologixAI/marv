import { expect, test } from "bun:test";
import { htmlToMarkdown } from "../src/tools/web/html.ts";

const ARTICLE = `<!doctype html><html><head><title>Release notes</title></head><body>
<nav><a href="/">Home</a> <a href="/docs">Docs</a></nav>
<article><h1>Version 2</h1><p>${"This release makes everything faster and fixes many bugs. ".repeat(6)}See the <a href="/guide">guide</a>.</p>
<pre><code class="language-ts">const x: number = 1;</code></pre>
<table><thead><tr><th>Option</th><th>Default</th></tr></thead><tbody><tr><td>fast</td><td>true</td></tr></tbody></table>
<img src="data:image/png;base64,${"A".repeat(1000)}" alt="inline"></article>
<footer>Copyright 2026</footer><script>track()</script></body></html>`;

test("keeps the article as Markdown and drops the page around it", () => {
  const { title, markdown, fallback } = htmlToMarkdown(ARTICLE, "https://example.com/blog/v2");
  expect(title).toBe("Release notes");
  expect(fallback).toBe(false);
  expect(markdown).toContain("faster and fixes many bugs");
  expect(markdown).toContain("[guide](https://example.com/guide)"); // absolute: the model can fetch it
  expect(markdown).toContain("```ts\nconst x: number = 1;\n```"); // the language survives
  expect(markdown).toContain("| Option | Default |");
  expect(markdown).not.toContain("[Docs]");
  expect(markdown).not.toContain("Copyright");
  expect(markdown).not.toContain("track()");
  expect(markdown).not.toContain("base64");
});

test("a page Readability can't read is converted whole, minus its menus", () => {
  const html = `<html><head><title>App</title></head><body><nav>Menu</nav><div id="root"><p>Loading the dashboard</p></div><footer>Footer</footer><script>boot()</script></body></html>`;
  const { title, markdown, fallback } = htmlToMarkdown(html, "https://app.example/");
  expect(fallback).toBe(true);
  expect(title).toBe("App");
  expect(markdown).toBe("Loading the dashboard");
});
