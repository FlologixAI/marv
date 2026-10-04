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

async function renderAt(width: number, message: Pick<Message, "role" | "text">) {
  const stdout = new FakeTerminal(width);
  const { unmount } = render(
    <Box width={width} flexDirection="column">
      <MessageView message={message} />
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
        expect(words).toEqual(LONG.split(/\s+/));
      });
    }
  }
});
