import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Box, render, Text } from "ink";
import { renderOptions } from "../src/render-options.ts";

const ROWS = 12;

// A terminal that records every byte Ink writes to it.
class FakeTerminal extends EventEmitter {
  isTTY = true;
  columns = 60;
  rows = ROWS;
  written = "";
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

// A full-screen frame where one row changes, like a martian blink.
function Screen({ eyes }: { eyes: string }) {
  return (
    <Box flexDirection="column" height={ROWS}>
      {Array.from({ length: ROWS - 1 }, (_, i) => (
        <Text key={i}>unchanged line {i}</Text>
      ))}
      <Text>{eyes}</Text>
    </Box>
  );
}

test("a one-line change rewrites that line, not the whole screen", async () => {
  const stdout = new FakeTerminal();
  const stdin = new FakeKeyboard();
  const { rerender, unmount } = render(<Screen eyes="◉ ◉" />, {
    ...renderOptions,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    interactive: true,
  });
  await Bun.sleep(50);

  stdout.written = "";
  rerender(<Screen eyes="─ ─" />);
  await Bun.sleep(50);
  const update = stdout.written;
  unmount();

  expect(update).toContain("─ ─");
  // A full redraw erases every line ("\x1b[2K") and repeats the unchanged text;
  // an incremental one does neither, so the screen never blanks (no flicker).
  expect(update).not.toContain("\x1b[2K");
  expect(update).not.toContain("unchanged line");
});
