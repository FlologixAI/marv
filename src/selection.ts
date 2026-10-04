// Mouse text selection. In the alternate screen with mouse reporting on, the
// terminal no longer selects text itself, so Ekko does it: it remembers each
// frame Ink renders (via the `transformOutput` hook we patched into Ink), and
// while you drag it inverts the selected cells in that frame. On release the
// selected text is read back out of the remembered frame.
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

/** A screen cell, 0-based. */
export interface Point {
  x: number;
  y: number;
}

/** Where the drag started (anchor) and where the pointer is now (focus). */
export interface Selection {
  anchor: Point;
  focus: Point;
}

const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

function ordered({ anchor, focus }: Selection): [Point, Point] {
  const anchorFirst = anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x);
  return anchorFirst ? [anchor, focus] : [focus, anchor];
}

/**
 * The columns [from, to) selected on row y, or null if the row isn't selected.
 * Like a terminal: the first row runs to the end of the line, middle rows are
 * whole, and the last row stops at the cell under the pointer (inclusive).
 */
function columnsOnRow(selection: Selection, y: number): [number, number] | null {
  const [start, end] = ordered(selection);
  if (y < start.y || y > end.y) return null;
  const from = y === start.y ? start.x : 0;
  const to = y === end.y ? end.x + 1 : Infinity;
  return [from, to];
}

/** The plain text inside the selection, one line per row, trailing spaces trimmed. */
export function selectedText(lines: string[], selection: Selection): string {
  const [start, end] = ordered(selection);
  const rows: string[] = [];
  for (let y = start.y; y <= end.y; y++) {
    const [from, to] = columnsOnRow(selection, y)!;
    const plain = stripAnsi(lines[y] ?? "");
    rows.push(sliceAnsi(plain, from, Math.min(to, stringWidth(plain))).trimEnd());
  }
  return rows.join("\n");
}

/** Returns the frame's lines with the selected cells shown in inverse video. */
export function highlightLines(lines: string[], selection: Selection): string[] {
  return lines.map((line, y) => {
    const columns = columnsOnRow(selection, y);
    if (!columns) return line;
    const width = stringWidth(line);
    const from = Math.min(columns[0], width);
    const to = Math.min(columns[1], width);
    if (from >= to) return line;
    // slice-ansi closes and reopens colors at the cut points, so the text on
    // either side keeps its style. The selected part is shown as plain inverse.
    const selected = stripAnsi(sliceAnsi(line, from, to));
    return sliceAnsi(line, 0, from) + INVERSE_ON + selected + INVERSE_OFF + sliceAnsi(line, to, width);
  });
}

const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/** Holds the current selection and the last frame; subscribable for React. */
export class SelectionStore {
  private selection: Selection | null = null;
  private frame: string[] = [];
  private listeners = new Set<() => void>();

  /** Pass to Ink's `transformOutput`: remembers the frame and draws the highlight. */
  transformOutput = (output: string): string => {
    this.frame = output.split("\n");
    return this.selection ? highlightLines(this.frame, this.selection).join("\n") : output;
  };

  start(point: Point) {
    this.set({ anchor: point, focus: point });
  }

  extend(point: Point) {
    if (this.selection) this.set({ anchor: this.selection.anchor, focus: point });
  }

  clear() {
    if (this.selection) this.set(null);
  }

  /** The selected text; empty for no selection or a click without a drag. */
  text(): string {
    if (!this.selection || samePoint(this.selection.anchor, this.selection.focus)) return "";
    return selectedText(this.frame, this.selection);
  }

  get current(): Selection | null {
    return this.selection;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: Selection | null) {
    this.selection = next;
    for (const listener of this.listeners) listener();
  }
}

/** The app-wide store, shared by cli.tsx (Ink's frame hook) and the App (mouse handling). */
export const selection = new SelectionStore();
