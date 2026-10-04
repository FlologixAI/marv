// Mouse text selection. In the alternate screen with mouse reporting on, the
// terminal no longer selects text itself, so Marv does.
//
// The selection lives in *transcript* coordinates (row 1250 of the
// conversation, not row 12 of the screen), so it stays on the same text as the
// transcript scrolls, and dragging past the top or bottom auto-scrolls to
// extend it. Only visible rows are ever drawn, so the store remembers the text
// of each transcript row as it passes through the viewport; that's what gets
// copied, the way a terminal keeps its scrollback.
//
// It sees each frame through the `transformOutput` hook we patched into Ink,
// and moving the highlight only needs Ink's (also patched) `repaint()`, not a
// React render.
import sliceAnsi from "slice-ansi";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

/** A cell: x is the column; y is a screen row, or a transcript row inside a Selection. */
export interface Point {
  x: number;
  y: number;
}

/** Where the drag started (anchor) and where the pointer is now (focus), in transcript rows. */
export interface Selection {
  anchor: Point;
  focus: Point;
}

/** Where the transcript sits on screen and how far it's scrolled; published by its ScrollView. */
export interface Viewport {
  /** Screen row of the transcript's first visible row. */
  top: number;
  /** Visible rows. */
  height: number;
  /** Transcript row shown at `top`. */
  scrollTop: number;
  contentHeight: number;
  width: number;
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
  return [y === start.y ? start.x : 0, y === end.y ? end.x + 1 : Infinity];
}

/** Shows the cells [from, to) of a line in inverse video, keeping its colors either side. */
export function highlightRow(line: string, [from, to]: [number, number]): string {
  const width = stringWidth(line);
  const start = Math.min(from, width);
  const end = Math.min(to, width);
  if (start >= end) return line;
  // slice-ansi closes and reopens colors at the cut points, so the text on
  // either side keeps its style. The selected part is shown as plain inverse.
  const selected = stripAnsi(sliceAnsi(line, start, end));
  return sliceAnsi(line, 0, start) + INVERSE_ON + selected + INVERSE_OFF + sliceAnsi(line, end, width);
}

const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

export class SelectionStore {
  /** Redraws the highlight without a React render: Ink's repaint() (set in cli.tsx). */
  repaint: () => void = () => {};

  private selection: Selection | null = null;
  private viewport: Viewport | null = null;
  private scrollBy: (rows: number) => void = () => {};
  /** Plain text of each transcript row, as last seen on screen. */
  private rows = new Map<number, string>();
  /** The viewport the last *new* frame was drawn with (a repaint reuses that frame). */
  private frameViewport: Viewport | null = null;
  private lastFrame: string | null = null;
  private autoScroll: { direction: -1 | 1; timer: ReturnType<typeof setInterval> } | null = null;
  private repaintQueued = false;
  private readonly autoScrollMs: number;

  constructor({ autoScrollMs = 50 }: { autoScrollMs?: number } = {}) {
    this.autoScrollMs = autoScrollMs;
  }

  /** Called by the transcript's ScrollView on every render. */
  setViewport = (viewport: Viewport, scrollBy: (rows: number) => void) => {
    const previous = this.viewport;
    // A new width reflows the text and a new height moves rows around on screen:
    // the remembered rows no longer line up.
    if (previous && (previous.width !== viewport.width || previous.height !== viewport.height)) this.reset();
    this.viewport = viewport;
    this.scrollBy = scrollBy;
  };

  /** Pass to Ink's `transformOutput`: remembers the visible rows and draws the highlight. */
  transformOutput = (output: string): string => {
    const lines = output.split("\n");
    if (output !== this.lastFrame) {
      // A newly drawn frame (a repaint passes the same one again).
      this.lastFrame = output;
      this.frameViewport = this.viewport;
      const vp = this.frameViewport;
      if (vp) for (let y = vp.top; y < vp.top + vp.height && y < lines.length; y++) this.rows.set(y - vp.top + vp.scrollTop, stripAnsi(lines[y]!));
    }
    const vp = this.frameViewport;
    const selection = this.selection;
    if (!vp || !selection) return output;
    return lines
      .map((line, y) => {
        if (y < vp.top || y >= vp.top + vp.height) return line;
        const columns = columnsOnRow(selection, y - vp.top + vp.scrollTop);
        return columns ? highlightRow(line, columns) : line;
      })
      .join("\n");
  };

  /** Mouse down: start a selection if it's on the transcript. */
  press(point: Point) {
    this.stopAutoScroll();
    const at = this.toTranscript(point, false);
    this.set(at ? { anchor: at, focus: at } : null);
  }

  /** Mouse moved with the button held: extend, and auto-scroll while past an edge. */
  drag(point: Point) {
    if (!this.selection || !this.viewport) return;
    const vp = this.viewport;
    const direction = point.y < vp.top ? -1 : point.y >= vp.top + vp.height ? 1 : 0;
    if (direction === 0) {
      this.stopAutoScroll();
      this.set({ anchor: this.selection.anchor, focus: this.toTranscript(point, true)! });
    } else if (this.autoScroll?.direction !== direction) {
      this.stopAutoScroll();
      const step = () => this.scrollStep(direction);
      step();
      this.autoScroll = { direction, timer: setInterval(step, this.autoScrollMs) };
    }
  }

  /** Mouse up: returns the selected text to copy (empty for a plain click). The highlight stays. */
  release(): string {
    this.stopAutoScroll();
    const selection = this.selection;
    if (!selection || samePoint(selection.anchor, selection.focus)) {
      this.set(null);
      return "";
    }
    const [start, end] = ordered(selection);
    const text: string[] = [];
    for (let y = start.y; y <= end.y; y++) {
      const row = this.rows.get(y);
      if (row === undefined) continue;
      const [from, to] = columnsOnRow(selection, y)!;
      text.push(sliceAnsi(row, from, Math.min(to, stringWidth(row))).trimEnd());
    }
    return text.join("\n");
  }

  clear() {
    this.stopAutoScroll();
    if (this.selection) this.set(null);
  }

  /** Forgets the selection and the remembered rows (after /clear or a resize). */
  reset() {
    this.stopAutoScroll();
    this.rows.clear();
    this.lastFrame = null;
    this.selection = null;
  }

  /** Scrolls one row past the edge and extends the selection onto the row coming into view. */
  private scrollStep(direction: -1 | 1) {
    const vp = this.viewport;
    if (!vp || !this.selection) return this.stopAutoScroll();
    const row = direction < 0 ? Math.max(0, vp.scrollTop - 1) : Math.min(vp.contentHeight - 1, vp.scrollTop + vp.height);
    this.set({ anchor: this.selection.anchor, focus: { x: direction < 0 ? 0 : vp.width - 1, y: row } });
    this.scrollBy(direction);
  }

  private stopAutoScroll() {
    if (this.autoScroll) clearInterval(this.autoScroll.timer);
    this.autoScroll = null;
  }

  /** Screen point → transcript point. Outside the transcript: null, or clamped to its edge rows. */
  private toTranscript({ x, y }: Point, clamp: boolean): Point | null {
    const vp = this.viewport;
    if (!vp) return null;
    if (y < vp.top || y >= vp.top + vp.height) {
      if (!clamp) return null;
      y = Math.min(Math.max(y, vp.top), vp.top + vp.height - 1);
    }
    return { x, y: y - vp.top + vp.scrollTop };
  }

  private set(next: Selection | null) {
    this.selection = next;
    // A burst of mouse events (one stdin chunk) becomes a single repaint.
    if (this.repaintQueued) return;
    this.repaintQueued = true;
    queueMicrotask(() => {
      this.repaintQueued = false;
      this.repaint();
    });
  }
}

/** The app-wide store, shared by cli.tsx (Ink's hooks), the App (mouse), and the transcript's ScrollView. */
export const selection = new SelectionStore();
