import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Box, render } from "ink";
import stringWidth from "string-width";
import type { Message } from "../src/types.ts";
import { MessageView } from "../src/ui/MessageView.tsx";

// Renders through Ink's real renderer at a given terminal width and returns the plain lines.
class FakeTerminal extends EventEmitter {
  isTTY = true;
  rows = 40;
  written = "";
  constructor(readonly columns: number) {
    super();
  }
  write = (data: string) => {
    this.written += data;
    return true;
  };
}
class FakeKeyboard extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  setEncoding() {}
  read() {
    return null;
  }
  ref() {}
  unref() {}
}

async function renderAt(width: number, message: Pick<Message, "role" | "text" | "tool" | "markdown">, showSteps = false) {
  const stdout = new FakeTerminal(width);
  const { unmount } = render(
    <Box width={width} flexDirection="column">
      <MessageView message={message} showSteps={showSteps} />
    </Box>,
    { stdout: stdout as unknown as NodeJS.WriteStream, stdin: new FakeKeyboard() as unknown as NodeJS.ReadStream, interactive: true },
  );
  await Bun.sleep(30);
  unmount();
  return stdout.written
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .filter((line) => line.trim());
}

const LONG =
  "ScrollView calculates one Page Up scroll distance using the formula `viewport.clientHeight - 1` (line 35), which " +
  "ensures exactly one row of overlap with the previously visible area remains pinned to the top. When PgUp is pressed, " +
  "it calls scrollBy(-page), moving up by that many rows before clamping against 0.";

describe("MessageView wrapping", () => {
  // A line wider than the terminal wraps on its own and the next line overwrites
  // the overflow, so a character disappears at every wrap.
  for (const width of [40, 79, 80, 120, 121]) {
    for (const role of ["assistant", "user"] as const) {
      test(`${role} text never exceeds a ${width}-column terminal, and no words are lost`, async () => {
        const lines = await renderAt(width, { role, text: LONG });
        for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width);
        const words = lines.join(" ").replace(/^[●>]\s*/, "").split(/\s+/).filter(Boolean);
        // Replies are rendered as Markdown, so their `code` loses its backticks.
        const expected = role === "assistant" ? LONG.replaceAll("`", "") : LONG;
        expect(words).toEqual(expected.split(/\s+/));
      });
    }
  }

  test("nested Markdown lists stay within the terminal at any width", async () => {
    const text = "- Core: `agent.ts`, `app.tsx`, `cli.tsx`, `prompt.ts`, `paths.ts`, `mouse.ts`, `selection.ts`\n  - UI: `Martian.tsx`, `MessageView.tsx`, `ModelPicker.tsx`, `PromptInput.tsx`, `ScrollView.tsx`";
    for (const width of [30, 57, 80, 121]) {
      for (const line of await renderAt(width, { role: "assistant", text })) expect(stringWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("a Markdown notice (like /skills) wraps with a hanging indent", async () => {
    const text = "- `/count-lines`: Count lines of code in the project, broken down by file type. Use when asked how big the project is.";
    const lines = await renderAt(40, { role: "system", text, markdown: true });
    expect(lines[0]).toStartWith("• /count-lines: Count");
    for (const line of lines.slice(1)) expect(line).toStartWith("  "); // continuation lines stay under the text
  });

  test("tool lines stay within the terminal too", async () => {
    const lines = await renderAt(40, { role: "tool", text: "read_file", tool: { label: "src/a/very/long/path/to/some/file.ts", status: "done", summary: "1 line" } });
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(40);
  });
});

// Ink itself already drops these sequences, so these pass even without `printable`.
// They guard against a future Ink (or a render path) that passes control sequences through.
describe("MessageView terminal control sequences", () => {
  const EVIL = "\x1b]52;c;aGk=\x07";
  const messages: Pick<Message, "role" | "text" | "tool" | "markdown">[] = [
    { role: "assistant", text: `before ${EVIL}after` },
    { role: "tool", text: `read${EVIL}_file`, tool: { label: `a${EVIL}.ts`, status: "done", summary: `1${EVIL} line`, steps: [`s${EVIL}tep`] } },
    { role: "system", text: `note ${EVIL}here` },
    { role: "system", text: `note ${EVIL}here`, markdown: true },
  ];
  for (const message of messages) {
    test(`${message.role}${message.markdown ? " (markdown)" : ""} never reaches the terminal with an escape sequence`, async () => {
      const stdout = new FakeTerminal(80);
      const { unmount } = render(
        <Box width={80} flexDirection="column">
          <MessageView message={message} showSteps />
        </Box>,
        { stdout: stdout as unknown as NodeJS.WriteStream, stdin: new FakeKeyboard() as unknown as NodeJS.ReadStream, interactive: true },
      );
      await Bun.sleep(30);
      unmount();
      const plain = stdout.written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      expect(plain).not.toContain("\x1b");
      expect(plain).not.toContain("\x07");
    });
  }
});

describe("MessageView diffs", () => {
  const lines = Array.from({ length: 20 }, (_, i) => ({ kind: "add" as const, text: `row ${i + 1}`, newLine: i + 1 }));
  const edit = (more = 0): Pick<Message, "role" | "text" | "tool"> => ({
    role: "tool",
    text: "write_file",
    tool: { label: "a.txt", status: "done", summary: "created · 20 lines", diff: { lines, more } },
  });

  test("collapsed: the first 15 lines, numbered, then how many more and how to see them", async () => {
    const out = (await renderAt(80, edit())).join("\n");
    expect(out).toContain(" 1 + row 1");
    expect(out).toContain("15 + row 15");
    expect(out).not.toContain("row 16");
    expect(out).toContain("… 5 more lines (ctrl+o)");
  });

  test("expanded (ctrl+o): everything kept, and what the result left out", async () => {
    const out = (await renderAt(80, edit(30), true)).join("\n");
    expect(out).toContain("20 + row 20");
    expect(out).toContain("… 30 more lines");
    expect(out).not.toContain("(ctrl+o)");
  });

  test("removed lines show their old number", async () => {
    const out = (await renderAt(80, { role: "tool", text: "edit_file", tool: { label: "a.txt", status: "done", summary: "+1 −1", diff: { lines: [{ kind: "del", text: "old", oldLine: 7 }, { kind: "add", text: "new", newLine: 7 }], more: 0 } } })).join("\n");
    expect(out).toContain("7 - old");
    expect(out).toContain("7 + new");
  });
});
