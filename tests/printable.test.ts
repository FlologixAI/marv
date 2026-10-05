import { expect, test } from "bun:test";
import { printable } from "../src/printable.ts";

test("removes C0/C1 control characters and escape sequences, keeps newlines, tabs and Unicode", () => {
  expect(printable("a\x1b]52;c;aGk=\x07b")).toBe("ab"); // OSC 52 clipboard write
  expect(printable("a\x1b]0;title\x1b\\b")).toBe("ab"); // OSC ended by ST
  expect(printable("x\x1b[2Jy")).toBe("xy"); // clear screen
  expect(printable("\x9b31mred")).toBe("red"); // 8-bit CSI
  expect(printable("a\x9d52;c;aGk=\x07b")).toBe("ab"); // 8-bit OSC
  expect(printable("a\x85b\x80c")).toBe("abc"); // lone C1 controls
  expect(printable("line 1\nline 2\tok · ✓ 日本")).toBe("line 1\nline 2\tok · ✓ 日本");
  expect(printable("bell\x07 back\x08")).toBe("bell back");
  expect(printable("a\rb")).toBe("ab"); // carriage return would overwrite the line
});

test("leaves legitimate Unicode alone", () => {
  const text = "日本語 한국어 😀👨‍👩‍👧 é é ┌─┬─┐│ ├─┼─┤ └─┴─┘ █▓▒░ ⎿ ● ▎ … ñ ü ß Ω";
  expect(printable(text)).toBe(text);
});
