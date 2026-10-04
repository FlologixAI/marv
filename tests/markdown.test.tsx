import { afterEach, describe, expect, test } from "bun:test";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { Markdown } from "../src/ui/Markdown.tsx";

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
