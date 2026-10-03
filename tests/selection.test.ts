import { describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import { highlightLines, SelectionStore, selectedText, type Selection } from "../src/selection.ts";

const INVERSE = "\x1b[7m";
const sel = (ax: number, ay: number, fx: number, fy: number): Selection => ({
  anchor: { x: ax, y: ay },
  focus: { x: fx, y: fy },
});

const SCREEN = ["hello world", "second line   ", "third"];

describe("selectedText", () => {
  test("selects within one row, including the cell under the cursor", () => {
    expect(selectedText(SCREEN, sel(0, 0, 4, 0))).toBe("hello");
  });

  test("works when dragging backwards", () => {
    expect(selectedText(SCREEN, sel(4, 0, 0, 0))).toBe("hello");
  });

  test("spans rows like a terminal: rest of first row, whole middle rows, start of last", () => {
    expect(selectedText(SCREEN, sel(6, 0, 2, 2))).toBe("world\nsecond line\nthi");
  });

  test("ignores colors and trims trailing spaces on each row", () => {
    expect(selectedText(["\x1b[31mred\x1b[39m text   "], sel(0, 0, 20, 0))).toBe("red text");
  });

  test("counts wide characters by their screen width", () => {
    // "●" is 1 column, "日" is 2.
    expect(selectedText(["● 日本 ok"], sel(2, 0, 5, 0))).toBe("日本");
  });
});

describe("highlightLines", () => {
  test("inverts only the selected cells and keeps the text identical", () => {
    const out = highlightLines(SCREEN, sel(6, 0, 2, 1));
    expect(out.map((l) => stripAnsi(l))).toEqual(SCREEN);
    expect(out[0]).toBe(`hello ${INVERSE}world\x1b[27m`);
    expect(out[1]).toStartWith(`${INVERSE}sec\x1b[27m`);
    expect(out[2]).toBe("third");
  });

  test("keeps the original colors around the highlight", () => {
    const [line] = highlightLines(["\x1b[31mabcdef\x1b[39m"], sel(2, 0, 3, 0));
    expect(stripAnsi(line!)).toBe("abcdef");
    expect(line).toContain(`${INVERSE}cd\x1b[27m`);
    expect(line).toStartWith("\x1b[31mab");
  });
});

describe("SelectionStore", () => {
  test("highlights the frame while selecting and copies text from the unhighlighted frame", () => {
    const store = new SelectionStore();
    const frame = SCREEN.join("\n");
    expect(store.transformOutput(frame)).toBe(frame);

    store.start({ x: 0, y: 0 });
    store.extend({ x: 4, y: 0 });
    expect(store.transformOutput(frame)).toContain(INVERSE);
    expect(store.text()).toBe("hello");

    store.clear();
    expect(store.transformOutput(frame)).toBe(frame);
    expect(store.text()).toBe("");
  });

  test("a click without a drag is not a selection", () => {
    const store = new SelectionStore();
    store.transformOutput(SCREEN.join("\n"));
    store.start({ x: 3, y: 0 });
    expect(store.text()).toBe("");
  });

  test("notifies subscribers when the selection changes", () => {
    const store = new SelectionStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => calls++);
    store.start({ x: 0, y: 0 });
    store.extend({ x: 1, y: 0 });
    store.clear();
    store.clear(); // already clear: no change, no notification
    unsubscribe();
    expect(calls).toBe(3);
  });
});
