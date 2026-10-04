// A change as diff lines, for the approval prompt and the transcript summary.
import { structuredPatch } from "diff";
import type { DiffLine } from "./types.ts";

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
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const text = line.slice(1);
      if (line[0] === "+") {
        added++;
        lines.push({ kind: "add", text });
      } else if (line[0] === "-") {
        removed++;
        lines.push({ kind: "del", text });
      } else lines.push({ kind: "ctx", text });
    }
  });
  return { lines, added, removed };
}

/** "+3 −1" (a real minus sign, which lines up with the plus). */
export const changeSummary = ({ added, removed }: Diff) => `+${added} −${removed}`;
