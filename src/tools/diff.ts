// A change as diff lines, for the approval prompt and the transcript.
import { structuredPatch } from "diff";
import type { DiffLine, DiffShown } from "./types.ts";

export interface Diff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Changed lines with a little context; a "gap" marks skipped unchanged lines between hunks. */
export function diffText(before: string, after: string, context = 3): Diff {
  const { hunks } = structuredPatch("a", "b", before, after, "", "", { context });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  hunks.forEach((hunk, i) => {
    if (i > 0) lines.push({ kind: "gap", text: "…" });
    // Each hunk says where it starts in the old and the new file; count from there.
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const text = line.slice(1);
      if (line[0] === "+") {
        added++;
        lines.push({ kind: "add", text, newLine: newLine++ });
      } else if (line[0] === "-") {
        removed++;
        lines.push({ kind: "del", text, oldLine: oldLine++ });
      } else lines.push({ kind: "ctx", text, oldLine: oldLine++, newLine: newLine++ });
    }
  });
  return { lines, added, removed };
}

/** "+3 −1" (a real minus sign, which lines up with the plus). */
export const changeSummary = ({ added, removed }: Diff) => `+${added} −${removed}`;

/** A new file as a diff: every line added, numbered from 1. */
export function addedLines(content: string): DiffLine[] {
  const text = content.replace(/\n$/, "");
  return text === "" ? [] : text.split("\n").map((line, i) => ({ kind: "add" as const, text: line, newLine: i + 1 }));
}

/** The most lines of one change a tool result keeps for the transcript (saved sessions hold them too). */
export const MAX_SHOWN_DIFF = 400;

export function shownDiff(lines: DiffLine[]): DiffShown {
  return { lines: lines.slice(0, MAX_SHOWN_DIFF), more: Math.max(0, lines.length - MAX_SHOWN_DIFF) };
}
