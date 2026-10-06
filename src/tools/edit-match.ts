// How edit_file finds old_string in a file. Exact first; when that finds nothing, two forgiving matches for the
// way models most often copy text wrong, each on whole lines and only when it's unique:
//   - trailing whitespace dropped (editors and models both strip it);
//   - indentation changed: spaces for the file's tabs, or the block copied without its outer indentation. The
//     replacement is then re-indented the same way, so the file keeps its own style.
// In a file whose line breaks are all CRLF, old_string and new_string get CRLF too: a model writes \n, and an edit
// that inserts bare \n leaves the file with mixed line endings.
// When nothing matches, closestLines() finds the part of the file most like old_string, so the error can show the
// model the current text instead of sending it back to read_file.

export type Fuzzy = "trailing-whitespace" | "indentation";
export type EditResult = { text: string; count: number; fuzzy?: Fuzzy } | { error: "not_found" } | { error: "ambiguous"; count: number };

/** "\r\n" when every line break in the text is one; otherwise "\n" (a mixed file is left as it is). */
export function lineEnding(text: string): "\r\n" | "\n" {
  const crlf = text.split("\r\n").length - 1;
  return crlf > 0 && crlf === text.split("\n").length - 1 ? "\r\n" : "\n";
}

/** The text with its bare \n turned into `eol` (only ever CRLF; LF text is returned as it is). */
export const withLineEnding = (text: string, eol: "\r\n" | "\n") => (eol === "\n" ? text : text.replace(/\r?\n/g, "\r\n"));

const leading = (line: string) => line.slice(0, line.length - line.trimStart().length);

/** How many columns an indentation takes, with tabs `width` wide. */
const columns = (indent: string, width: number) => {
  let col = 0;
  for (const ch of indent) col = ch === "\t" ? col + width - (col % width) : col + 1;
  return col;
};

/**
 * A function that re-indents a line of new_string the way the file's lines differ from old_string's, or null when
 * no single rule explains every line: the same column shift for all of them, with tabs 4, 2 or 8 wide, written with
 * tabs if the file's matched lines use them. An unindented first line is old_string starting at the code (an exact
 * match may start mid-line too): it isn't counted, and new_string's first line gets the file's indentation there.
 */
function reindenter(fileLines: string[], oldLines: string[]): ((line: string, index: number) => string) | null {
  const fromCode = leading(oldLines[0]!) === "" && leading(fileLines[0]!) !== "";
  const pairs = fileLines.map((line, i) => [line, oldLines[i]!] as const).filter(([line], i) => line.trim() !== "" && !(fromCode && i === 0));
  const tabs = fileLines.some((line) => leading(line).includes("\t"));
  for (const width of [4, 2, 8]) {
    const shifts = new Set(pairs.map(([line, old]) => columns(leading(line), width) - columns(leading(old), width)));
    if (shifts.size > 1) continue;
    const [shift = 0] = [...shifts];
    return (line, index) => {
      if (line.trim() === "") return "";
      if (fromCode && index === 0) return leading(fileLines[0]!) + line.trimStart();
      const col = Math.max(0, columns(leading(line), width) + shift);
      const indent = tabs ? "\t".repeat(Math.floor(col / width)) + " ".repeat(col % width) : " ".repeat(col);
      return indent + line.trimStart();
    };
  }
  return null;
}

/** Where whole lines of the file match old_string's lines under `same`: the first line of each, without overlaps. */
function lineMatches(fileLines: string[], oldLines: string[], same: (a: string, b: string) => boolean): number[] {
  const found: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    if (oldLines.every((old, j) => same(fileLines[i + j]!, old))) {
      found.push(i);
      i += oldLines.length - 1;
    }
  }
  return found;
}

/** old_string replaced by new_string in `text` (exactly, then forgivingly), or why it couldn't be. */
export function applyEdit(text: string, oldString: string, newString: string, replaceAll: boolean): EditResult {
  const eol = lineEnding(text);
  const old = withLineEnding(oldString, eol);
  const replacement = withLineEnding(newString, eol);

  const exact = text.split(old).length - 1;
  if (exact > 1 && !replaceAll) return { error: "ambiguous", count: exact };
  if (exact > 0) {
    return { text: replaceAll ? text.split(old).join(replacement) : text.replace(old, () => replacement), count: exact };
  }

  // Whole lines from here on. A trailing line break in old_string stays part of what's replaced, as it would be
  // in an exact match.
  const trailing = old.endsWith(eol);
  const oldLines = (trailing ? old.slice(0, -eol.length) : old).split(eol);
  const fileLines = text.split(eol);
  const stages: [Fuzzy, (a: string, b: string) => boolean][] = [
    ["trailing-whitespace", (a, b) => a.trimEnd() === b.trimEnd()],
    ["indentation", (a, b) => a.trim() === b.trim()],
  ];
  for (const [fuzzy, same] of stages) {
    const starts = lineMatches(fileLines, oldLines, same);
    if (starts.length === 0) continue;
    if (starts.length > 1 && !replaceAll) return { error: "ambiguous", count: starts.length };
    let newLines = replacement.split(eol);
    if (fuzzy === "indentation") {
      // Every match must re-indent the same way; one rule from the first is applied to all.
      const reindent = reindenter(fileLines.slice(starts[0]!, starts[0]! + oldLines.length), oldLines);
      if (!reindent || starts.some((s) => !reindenter(fileLines.slice(s, s + oldLines.length), oldLines))) return { error: "not_found" };
      newLines = newLines.map(reindent);
    }
    // Splice by character offsets: each matched block runs from its first line's start to its last line's end,
    // plus that line's break when old_string ended with one.
    const lineStart = [0];
    for (const line of fileLines) lineStart.push(lineStart.at(-1)! + line.length + eol.length);
    const inserted = newLines.join(eol);
    let out = "";
    let at = 0;
    for (const start of starts) {
      const last = start + oldLines.length - 1;
      let end = lineStart[last]! + fileLines[last]!.length;
      if (trailing && last < fileLines.length - 1) end += eol.length;
      out += text.slice(at, lineStart[start]) + inserted;
      at = end;
    }
    return { text: out + text.slice(at), count: starts.length, fuzzy };
  }
  return { error: "not_found" };
}

/** The set of character pairs in a line, for comparing lines. */
const bigrams = (line: string) => {
  const set = new Set<string>();
  for (let i = 0; i < line.length - 1; i++) set.add(line.slice(i, i + 2));
  return set;
};

/** 0 (nothing in common) to 1 (the same, ignoring surrounding whitespace). */
function similarity(a: string, b: string, setA: Set<string>, setB: Set<string>): number {
  if (a === b) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const pair of setA) if (setB.has(pair)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

const MAX_SCAN_LINES = 20_000;
const MAX_OLD_LINES = 200;
/** Below this, the "closest" text is probably unrelated and showing it would only mislead. */
const MIN_SIMILARITY = 0.5;

/** The 1-based, inclusive line range of `text` most like old_string, or null if nothing is close. */
export function closestLines(text: string, oldString: string): { start: number; end: number } | null {
  const fileLines = text.split(/\r?\n/).map((l) => l.trim());
  const oldLines = oldString.replace(/\r?\n$/, "").split(/\r?\n/).map((l) => l.trim());
  if (text === "" || oldString.trim() === "" || fileLines.length > MAX_SCAN_LINES || oldLines.length > MAX_OLD_LINES) return null;
  const k = Math.min(oldLines.length, fileLines.length);
  const fileSets = fileLines.map(bigrams);
  const oldSets = oldLines.map(bigrams);
  let best = { score: 0, start: -1 };
  for (let i = 0; i + k <= fileLines.length; i++) {
    let total = 0;
    for (let j = 0; j < k; j++) total += similarity(fileLines[i + j]!, oldLines[j]!, fileSets[i + j]!, oldSets[j]!);
    const score = total / oldLines.length;
    if (score > best.score) best = { score, start: i };
  }
  return best.score >= MIN_SIMILARITY ? { start: best.start + 1, end: best.start + k } : null;
}
