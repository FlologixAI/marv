import { expect, test } from "bun:test";
import { addedLines, diffText, MAX_SHOWN_DIFF, shownDiff } from "../src/tools/diff.ts";

test("diff lines carry line numbers: new for added and unchanged lines, old for removed ones, across hunks", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const after = before.replace("line 2\n", "line two\n").replace("line 18\n", "line 18\nline 18b\n");
  const { lines } = diffText(before, after, 1);
  expect(lines).toEqual([
    { kind: "ctx", text: "line 1", oldLine: 1, newLine: 1 },
    { kind: "del", text: "line 2", oldLine: 2 },
    { kind: "add", text: "line two", newLine: 2 },
    { kind: "ctx", text: "line 3", oldLine: 3, newLine: 3 },
    { kind: "gap", text: "…" },
    { kind: "ctx", text: "line 18", oldLine: 18, newLine: 18 },
    { kind: "add", text: "line 18b", newLine: 19 },
    { kind: "ctx", text: "line 19", oldLine: 19, newLine: 20 },
  ]);
});

test("a new file is all additions, numbered from 1", () => {
  expect(addedLines("a\nb\n")).toEqual([
    { kind: "add", text: "a", newLine: 1 },
    { kind: "add", text: "b", newLine: 2 },
  ]);
  expect(addedLines("")).toEqual([]);
});

test("what a result keeps is capped, and says how much it left out", () => {
  const many = addedLines(Array.from({ length: MAX_SHOWN_DIFF + 7 }, (_, i) => `l${i}`).join("\n"));
  expect(shownDiff(many)).toEqual({ lines: many.slice(0, MAX_SHOWN_DIFF), more: 7 });
  expect(shownDiff(many.slice(0, 3))).toEqual({ lines: many.slice(0, 3), more: 0 });
});
