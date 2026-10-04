import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";

// string-width is patched (patches/string-width@8.3.0.patch) to cache results
// and to skip its costly emoji regex for characters that can't be emoji. These
// pin down that the answers didn't change.
describe("string-width (patched)", () => {
  test.each([
    ["plain ascii", "hello world", 11],
    ["box drawing and bullets", "╭──● • ◦ ⎿ ▎│", 13],
    ["the martian", "━┫ ◉   ◉ ┣━", 11],
    ["em dash and accents", "café — naïve", 12],
    ["CJK is wide", "日本語", 6],
    ["simple emoji", "🙂", 2],
    ["emoji presentation selector", "❤️", 2],
    ["text-style heart stays narrow", "❤", 1],
    ["keycap sequence", "1️⃣", 2],
    ["flag (regional indicators)", "🇨🇦", 2],
    ["family (ZWJ sequence)", "👨‍👩‍👧", 2],
    ["skin tone modifier", "👍🏽", 2],
    ["combining marks are zero width", "é", 1],
    ["ANSI codes don't count", "\x1b[31mred\x1b[39m", 3],
    ["empty", "", 0],
  ])("%s", (_name, input, width) => {
    expect(stringWidth(input)).toBe(width);
    expect(stringWidth(input)).toBe(width); // and again, from the cache
  });

  test("options are part of the cache key", () => {
    expect(stringWidth("\x1b[31mx\x1b[39m")).toBe(1);
    expect(stringWidth("\x1b[31mx\x1b[39m", { countAnsiEscapeCodes: true })).toBeGreaterThan(1);
    expect(stringWidth("±", { ambiguousIsNarrow: true })).toBe(1);
    expect(stringWidth("±", { ambiguousIsNarrow: false })).toBe(2);
  });
});
