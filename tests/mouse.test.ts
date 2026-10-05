import { describe, expect, test } from "bun:test";
import { extractMouse, filterMouseInput, mouse, type MouseEvent } from "../src/mouse.ts";

const WHEEL_UP = "\x1b[<64;10;5M";
const WHEEL_DOWN = "\x1b[<65;10;5M";

describe("extractMouse", () => {
  test("turns wheel events into scroll steps (negative = up)", () => {
    expect(extractMouse(WHEEL_UP + WHEEL_UP + WHEEL_DOWN)).toEqual({
      rest: "",
      events: [
        { type: "scroll", step: -1 },
        { type: "scroll", step: -1 },
        { type: "scroll", step: 1 },
      ],
    });
  });

  test("reports left-button press, drag and release with 0-based cells", () => {
    expect(extractMouse("\x1b[<0;3;4M\x1b[<32;7;4M\x1b[<0;9;5m").events).toEqual([
      { type: "press", x: 2, y: 3 },
      { type: "drag", x: 6, y: 3 },
      { type: "release", x: 8, y: 4 },
    ]);
  });

  test("ignores middle and right buttons", () => {
    expect(extractMouse("\x1b[<1;3;4M\x1b[<2;3;4M\x1b[<2;3;4m")).toEqual({ rest: "", events: [] });
  });

  test("leaves ordinary input and other escape codes alone", () => {
    expect(extractMouse(`hi${WHEEL_DOWN}\x1b[A!`)).toEqual({ rest: "hi\x1b[A!", events: [{ type: "scroll", step: 1 }] });
  });

  test("still recognizes events with modifier keys held", () => {
    // +4 shift, +8 meta, +16 ctrl
    expect(extractMouse("\x1b[<80;1;1M\x1b[<16;1;1M").events).toEqual([
      { type: "scroll", step: -1 },
      { type: "press", x: 0, y: 0 },
    ]);
  });
});

describe("filterMouseInput", () => {
  test("hides mouse codes from the reader and emits them as events", () => {
    const chunks = ["a" + WHEEL_UP, "\x1b[<0;1;1M", "b"];
    const stdin = { read: () => chunks.shift() ?? null };
    const seen: MouseEvent[] = [];
    const onEvent = (event: MouseEvent) => seen.push(event);
    mouse.on("event", onEvent);
    filterMouseInput(stdin);

    // A chunk that was only mouse codes is skipped, not returned as "".
    expect([stdin.read(), stdin.read(), stdin.read()]).toEqual(["a", "b", null]);
    expect(seen).toEqual([
      { type: "scroll", step: -1 },
      { type: "press", x: 0, y: 0 },
    ]);
    mouse.off("event", onEvent);
  });

  /** Reads through a wrapped stdin, chunk by chunk, collecting what Ink would get and the mouse events. */
  function feed(chunks: (string | null)[], reads: number) {
    const queue = [...chunks];
    const stdin = { read: () => (queue.length ? queue.shift()! : null) };
    const seen: MouseEvent[] = [];
    const onEvent = (event: MouseEvent) => seen.push(event);
    mouse.on("event", onEvent);
    filterMouseInput(stdin);
    const got = Array.from({ length: reads }, () => stdin.read());
    mouse.off("event", onEvent);
    return { got: got.filter((c) => c !== null), seen };
  }

  test("a mouse code split across chunks still arrives whole, and never as typed text", () => {
    // The second half comes in a later read (null in between: nothing more yet, e.g. over SSH).
    const { got, seen } = feed(["x\x1b[<0;10;", null, "5M", "y"], 4);
    expect(got.join("")).toBe("xy");
    expect(seen).toEqual([{ type: "press", x: 9, y: 4 }]);
  });

  test("split right after the escape, with the rest already waiting, it's still one event", () => {
    const { got, seen } = feed(["x\x1b", "[<0;10;5M"], 2);
    expect(got.join("")).toBe("x");
    expect(seen).toEqual([{ type: "press", x: 9, y: 4 }]);
  });

  test("a lone Esc keypress isn't held back", () => {
    const { got } = feed(["\x1b", null], 1);
    expect(got).toEqual(["\x1b"]);
  });
});
