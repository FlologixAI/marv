import { afterEach, describe, expect, test } from "bun:test";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { marked, type Token } from "marked";
import { createStreamLexer, Markdown } from "../src/ui/Markdown.tsx";

afterEach(cleanup);

/** Renders markdown at a given width and returns the plain lines, trailing spaces trimmed. */
function show(text: string, width = 60) {
  const { lastFrame } = render(
    <Box width={width} flexDirection="column">
      <Markdown text={text} />
    </Box>,
  );
  return stripAnsi(lastFrame()!)
    .split("\n")
    .map((line) => line.trimEnd());
}

describe("Markdown", () => {
  test("paragraphs are separated by one blank line", () => {
    expect(show("First paragraph.\n\nSecond paragraph.")).toEqual(["First paragraph.", "", "Second paragraph."]);
  });

  test("inline code and emphasis lose their markers", () => {
    expect(show("Run `bun test` with **care** and *style*.")).toEqual(["Run bun test with care and style."]);
  });

  test("bullet lists wrap with a hanging indent, and nest", () => {
    const lines = show(
      "- Root: `package.json`, `tsconfig.json`, `bun.lock`, plus a patch at `patches/ink@8.0.0.patch`\n" +
        "- `src/` — the app itself:\n" +
        "  - Core: `agent.ts`, `app.tsx`, `cli.tsx`, `prompt.ts`, `paths.ts`, `mouse.ts`",
      44,
    );
    expect(lines).toEqual([
      "• Root: package.json, tsconfig.json,",
      "  bun.lock, plus a patch at",
      "  patches/ink@8.0.0.patch",
      "• src/ — the app itself:",
      "  ◦ Core: agent.ts, app.tsx, cli.tsx,",
      "    prompt.ts, paths.ts, mouse.ts",
    ]);
  });

  test("numbered lists keep their numbers aligned", () => {
    const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. item ${i + 1}`).join("\n");
    const lines = show(items);
    expect(lines[0]).toBe(" 1. item 1");
    expect(lines[9]).toBe("10. item 10");
  });

  test("task lists show checkboxes", () => {
    expect(show("- [x] done\n- [ ] todo")).toEqual(["☑ done", "☐ todo"]);
  });

  test("headings stand on their own line", () => {
    expect(show("## Layout\nSome text.")).toEqual(["Layout", "", "Some text."]);
  });

  test("code blocks keep their lines, behind a rule, with the language", () => {
    const lines = show("Before:\n\n```ts\nconst x = 1;\n  indented();\n```\n\nAfter.");
    expect(lines).toEqual(["Before:", "", "ts", "│ const x = 1;", "│   indented();", "", "After."]);
  });

  test("an unfinished code block (mid-stream) still renders", () => {
    expect(show("```ts\nconst x =")).toEqual(["ts", "│ const x ="]);
  });

  test("tables line up in columns", () => {
    expect(show("| Tool | Does |\n|---|---|\n| glob | finds files |\n| read_file | reads one |")).toEqual([
      "Tool       Does",
      "─────────  ───────────",
      "glob       finds files",
      "read_file  reads one",
    ]);
  });

  test("links show their target when it differs from the text", () => {
    expect(show("See [the docs](https://example.com) or https://bun.sh.")).toEqual(["See the docs (https://example.com) or https://bun.sh."]);
  });

  test("blockquotes get a bar", () => {
    expect(show("> careful here")).toEqual(["▎ careful here"]);
  });

  test("escaped characters come out plain", () => {
    expect(show("2 \\* 3 and a < b & c")).toEqual(["2 * 3 and a < b & c"]);
  });
});

describe("createStreamLexer (parsing a reply as it streams in)", () => {
  /** Feeds `text` in chunks, like a stream, and returns the final tokens. */
  function stream(text: string, chunk = 7) {
    const lex = createStreamLexer();
    let tokens = lex("");
    for (let i = chunk; i < text.length + chunk; i += chunk) tokens = lex(text.slice(0, i));
    return tokens;
  }
  const types = (tokens: { type: string }[]) => tokens.filter((t) => t.type !== "space").map((t) => t.type);

  test("gives the same blocks as parsing the whole text", () => {
    const text = "Intro paragraph.\n\n## Heading\n\nSome `code` here.\n\n- one\n- two\n\nOutro.";
    expect(types(stream(text))).toEqual(types(marked.lexer(text)));
  });

  test("never splits a code block at a blank line inside it", () => {
    const text = "Before.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.";
    const code = stream(text).filter((t) => t.type === "code");
    expect(code).toHaveLength(1);
    expect((code[0] as { text: string }).text).toBe("const a = 1;\n\nconst b = 2;");
  });

  test("keeps indented continuations with their list item", () => {
    const text = "- item one\n\n  more about item one\n\n- item two";
    const lists = stream(text).filter((t) => t.type === "list");
    expect(JSON.stringify(lists)).toContain("more about item one");
    expect(stream(text).some((t) => t.type === "code")).toBe(false); // not mistaken for an indented code block
  });

  test("while it streams, every partial reply parses like the same text parsed whole", () => {
    // Random replies built from tricky blocks, streamed in random chunks. (Left out: a reference link whose
    // definition comes later, which no incremental parse can know; finished replies are parsed whole anyway.)
    const BLOCKS = [
      "Some paragraph text with `code` and **bold**.",
      "- item one\n- item two\n  - nested\n- item three",
      "1. first\n\n2. second\n\n3. third", // a loose list: one list, not three
      "- loose item\n\n  continued para\n\n- next",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
      "~~~\nraw ``` inside\n\nmore\n~~~",
      "```js\nconsole.log(1)\n```js\n\n# not a heading\n\nstill code\n```", // ```js doesn't close it
      "````markdown\n## Install\n\n```sh\nbun install\n\nbun run dev\n```\n\n- list in md\n````", // a shorter fence inside
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "## Heading",
      "> quote line\n>\n> more quote",
      "<!--\n\nhidden comment\n\n-->",
      "```const x``` is inline code at line start",
    ];
    let seed = 777;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const shape = (tokens: Token[]) =>
      tokens
        .filter((t) => t.type !== "space")
        .map((t) => JSON.stringify({ type: t.type, text: (t as { text?: string }).text, items: (t as { items?: unknown[] }).items?.length }));
    for (let doc = 0; doc < 120; doc++) {
      const text = Array.from({ length: 2 + Math.floor(random() * 4) }, () => BLOCKS[Math.floor(random() * BLOCKS.length)]).join("\n\n");
      const lex = createStreamLexer();
      for (let at = 0; at < text.length; ) {
        at = Math.min(text.length, at + 1 + Math.floor(random() * 12));
        const prefix = text.slice(0, at);
        expect({ prefix, tokens: shape(lex(prefix)) }).toEqual({ prefix, tokens: shape(marked.lexer(prefix)) });
      }
    }
  });

  test("starts over when the text is replaced (a new reply)", () => {
    const lex = createStreamLexer();
    lex("First reply.\n\nSecond paragraph.");
    expect(types(lex("Something else entirely."))).toEqual(["paragraph"]);
  });

  test("re-parses only the unfinished end, so long replies stay fast", () => {
    const sample = "Some text with `code` and **bold**.\n\n- a list item\n- another one\n\n";
    const text = sample.repeat(300); // ~20 KB
    const lex = createStreamLexer();
    let slowest = 0;
    for (let i = 50; i <= text.length; i += 50) {
      const t0 = performance.now();
      lex(text.slice(0, i));
      slowest = Math.max(slowest, performance.now() - t0);
    }
    // Re-parsing the whole reply on each update takes ~30 ms at this size, and grows with it.
    expect(slowest).toBeLessThan(10);
  });
});
