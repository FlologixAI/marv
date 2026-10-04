// Mouse support. Ink only understands keyboard input, so Marv turns on the
// terminal's mouse reporting itself and pulls the mouse codes out of stdin
// before Ink sees them (otherwise they'd be typed into the prompt as text).
import { EventEmitter } from "node:events";

// 1002 = report presses, releases, and motion while a button is held (drags);
//        the wheel counts as buttons 64/65.
// 1006 = SGR encoding: ESC [ < button ; column ; row M (press/motion) or m (release).
export const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l";

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const MODIFIER_BITS = 4 | 8 | 16; // shift, meta, ctrl
const MOTION_BIT = 32;
const WHEEL_BIT = 64;
const LEFT_BUTTON = 0;

/** Cells are 0-based: x is the column, y the row. */
export type MouseEvent =
  | { type: "scroll"; step: -1 | 1 }
  | { type: "press" | "drag" | "release"; x: number; y: number };

/** Emits "event" with a MouseEvent for each wheel notch and left-button action. */
export const mouse = new EventEmitter();

function decode(code: number, x: number, y: number, final: string): MouseEvent | null {
  const button = code & ~MODIFIER_BITS;
  if (button & WHEEL_BIT) return { type: "scroll", step: (button & 1) === 0 ? -1 : 1 };
  if ((button & 3) !== LEFT_BUTTON) return null; // middle/right buttons
  const type = final === "m" ? "release" : button & MOTION_BIT ? "drag" : "press";
  return { type, x, y };
}

/** Splits a chunk of input into the non-mouse text and the mouse events it contained. */
export function extractMouse(chunk: string): { rest: string; events: MouseEvent[] } {
  const events: MouseEvent[] = [];
  const rest = chunk.replace(SGR_MOUSE, (_match, code: string, col: string, row: string, final: string) => {
    const event = decode(Number(code), Number(col) - 1, Number(row) - 1, final);
    if (event) events.push(event);
    return "";
  });
  return { rest, events };
}

/**
 * Wraps `stdin.read()` (which Ink calls in a loop) so mouse codes are removed
 * from every chunk and emitted on `mouse` instead.
 * Assumes stdin is in utf8 mode, which Ink sets up.
 */
export function filterMouseInput(stdin: { read: (size?: number) => unknown }) {
  const read = stdin.read.bind(stdin);
  stdin.read = (size?: number) => {
    for (;;) {
      const chunk = read(size);
      if (typeof chunk !== "string") return chunk;
      const { rest, events } = extractMouse(chunk);
      for (const event of events) mouse.emit("event", event);
      // A chunk that was only mouse codes: keep reading rather than hand Ink "".
      if (rest || !chunk) return rest;
    }
  };
}
