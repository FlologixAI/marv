import { expect, test } from "bun:test";
import { printable } from "../src/printable.ts";

test("removes C0/C1 control characters and escape sequences, keeps newlines, tabs and Unicode", () => {
  expect(printable("a\x1b]52;c;aGk=\x07b")).toBe("ab"); // OSC 52 clipboard write
  expect(printable("a\x1b]0;title\x1b\\b")).toBe("ab"); // OSC ended by ST
  expect(printable("x\x1b[2Jy")).toBe("xy"); // clear screen
  expect(printable("\x9b31mred")).toBe("red"); // 8-bit CSI
  expect(printable("a\x9d52;c;aGk=\x07b")).toBe("a52;c;aGk=b"); // 8-bit OSC: introducer dropped, payload is harmless text
  expect(printable("a\x85b\x80c")).toBe("abc"); // lone C1 controls
  expect(printable("line 1\nline 2\tok · ✓ 日本")).toBe("line 1\nline 2\tok · ✓ 日本");
  expect(printable("bell\x07 back\x08")).toBe("bell back");
  expect(printable("a\rb")).toBe("ab"); // carriage return would overwrite the line
});

test("leaves legitimate Unicode alone", () => {
  const text = "日本語 한국어 😀👨‍👩‍👧 é é ┌─┬─┐│ ├─┼─┤ └─┴─┘ █▓▒░ ⎿ ● ▎ … ñ ü ß Ω";
  expect(printable(text)).toBe(text);
});

test("UTF-8 text decoded as Latin-1 (mojibake) keeps all its words", () => {
  const text = "He said \u201chello\u201d and then \u201cgoodbye\u201d to everyone.\nNext paragraph";
  const mojibake = new TextDecoder("latin1").decode(new TextEncoder().encode(text));
  const out = printable(mojibake);
  for (const word of ["hello", "goodbye", "everyone.", "Next", "paragraph"]) expect(out).toContain(word);
  expect(out).toContain("\n");
});

test("an unfinished CSI at the end is dropped, and short ESC forms leave nothing behind", () => {
  expect(printable("a\x1b[31")).toBe("a");
  expect(printable("a\x1b")).toBe("a");
  expect(printable("a\x1b(Bb")).toBe("ab"); // tput sgr0
  expect(printable("a\x1b7b\x1b8c")).toBe("abc");
  expect(printable("a\x1b=b")).toBe("ab");
});
