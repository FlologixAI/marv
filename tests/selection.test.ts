import { afterEach, describe, expect, test } from "bun:test";
import stripAnsi from "strip-ansi";
import { highlightRow, SelectionStore, type Viewport } from "../src/selection.ts";

const INVERSE = "\x1b[7m";

/** A transcript of numbered lines; the screen shows `height` of them from `scrollTop`, then a prompt line. */
const TRANSCRIPT = Array.from({ length: 30 }, (_, i) => `line ${i}`);

function screenFor(store: SelectionStore, scrollTop: number, height = 5) {
  const viewport: Viewport = { top: 0, height, scrollTop, contentHeight: TRANSCRIPT.length, width: 40 };
  store.setViewport(viewport, (rows) => scrolled.push(rows));
  return [...TRANSCRIPT.slice(scrollTop, scrollTop + height), "> prompt"].join("\n");
}
let scrolled: number[] = [];
afterEach(() => {
  scrolled = [];
});

/** Renders a frame and returns the rows that were highlighted (by their plain text). */
function highlighted(frame: string): string[] {
  return frame.split("\n").filter((line) => line.includes(INVERSE)).map((line) => stripAnsi(line));
}

describe("highlightRow", () => {
  test("inverts only the given columns and keeps the original colors around them", () => {
    const line = highlightRow("\x1b[31mabcdef\x1b[39m", [2, 4]);
    expect(stripAnsi(line)).toBe("abcdef");
    expect(line).toContain(`${INVERSE}cd\x1b[27m`);
    expect(line).toStartWith("\x1b[31mab");
  });

  test("an edge inside a wide character takes the whole character (it never disappears)", () => {
    const line = "ab中文cd😀ef";
    for (const range of [[2, 3], [3, 5], [8, 9], [3, 4]] as [number, number][]) {
      const out = highlightRow(line, range);
      expect(stripAnsi(out)).toBe(line); // nothing lost, the rest of the line doesn't shift
    }
    expect(highlightRow(line, [3, 5])).toContain(`${INVERSE}中文\x1b[27m`);
  });

  test("counts wide characters by their screen width", () => {
    expect(stripAnsi(highlightRow("● 日本 ok", [2, 6]))).toBe("● 日本 ok");
    expect(highlightRow("● 日本 ok", [2, 6])).toContain(`${INVERSE}日本\x1b[27m`);
  });
});

describe("SelectionStore", () => {
  test("drag selects like a terminal and copies the text", () => {
    const store = new SelectionStore();
    store.transformOutput(screenFor(store, 0));
    store.press({ x: 5, y: 1 }); // "line 1", from the "1"
    store.drag({ x: 3, y: 3 }); // to "line" of "line 3"
    expect(highlighted(store.transformOutput(screenFor(store, 0)))).toEqual(["line 1", "line 2", "line 3"]);
    expect(store.release()).toBe("1\nline 2\nline");
  });

  test("copying across wide characters copies whole characters", () => {
    const store = new SelectionStore();
    const frame = ["ab中文cd😀ef", "> prompt"].join("\n");
    store.setViewport({ top: 0, height: 1, scrollTop: 0, contentHeight: 1, width: 40 }, () => {});
    store.transformOutput(frame);
    store.press({ x: 3, y: 0 }); // the second half of 中
    store.drag({ x: 4, y: 0 }); // the first half of 文
    expect(store.release()).toBe("中文");
  });

  test("the highlight stays on the same text when the transcript scrolls", () => {
    const store = new SelectionStore();
    store.transformOutput(screenFor(store, 10));
    store.press({ x: 0, y: 0 });
    store.drag({ x: 5, y: 0 }); // "line 10"
    const after = store.transformOutput(screenFor(store, 8)); // scrolled up 2 rows: "line 10" is now on screen row 2
    expect(after.split("\n")[2]).toContain(INVERSE);
    expect(highlighted(after)).toEqual(["line 10"]);
  });

  test("copies rows that have scrolled out of view, from what was seen", () => {
    const store = new SelectionStore();
    store.transformOutput(screenFor(store, 0)); // rows 0-4 seen
    store.press({ x: 0, y: 1 });
    store.transformOutput(screenFor(store, 5)); // scrolled: rows 5-9 seen, row 1 now off screen
    store.drag({ x: 5, y: 2 }); // to "line 7"
    expect(store.release()).toBe("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7");
  });

  test("dragging below the transcript auto-scrolls and extends the selection", async () => {
    const store = new SelectionStore({ autoScrollMs: 10 });
    store.transformOutput(screenFor(store, 0));
    store.press({ x: 0, y: 3 });
    store.drag({ x: 2, y: 5 }); // the prompt row, just below the 5-row transcript
    await Bun.sleep(45);
    expect(scrolled.length).toBeGreaterThanOrEqual(2);
    expect(scrolled.every((rows) => rows === 1)).toBe(true);

    store.drag({ x: 2, y: 4 }); // back inside: auto-scroll stops
    const count = scrolled.length;
    await Bun.sleep(30);
    expect(scrolled.length).toBe(count);
    store.release();
  });

  test("dragging above the transcript scrolls up", async () => {
    const store = new SelectionStore({ autoScrollMs: 10 });
    store.transformOutput(screenFor(store, 10, 5));
    store.setViewport({ top: 2, height: 5, scrollTop: 10, contentHeight: 30, width: 40 }, (rows) => scrolled.push(rows));
    store.press({ x: 0, y: 4 });
    store.drag({ x: 0, y: 0 }); // above the transcript's first row
    await Bun.sleep(25);
    expect(scrolled[0]).toBe(-1);
    store.release();
  });

  test("a click without a drag selects nothing, and a click outside the transcript is ignored", () => {
    const store = new SelectionStore();
    store.transformOutput(screenFor(store, 0));
    store.press({ x: 3, y: 1 });
    expect(store.release()).toBe("");
    store.press({ x: 3, y: 5 }); // the prompt row
    store.drag({ x: 8, y: 5 });
    expect(store.release()).toBe("");
  });

  test("selection changes ask for a repaint, batched per burst of mouse events", async () => {
    const store = new SelectionStore();
    let repaints = 0;
    store.repaint = () => repaints++;
    store.transformOutput(screenFor(store, 0));
    store.press({ x: 0, y: 0 });
    for (let x = 1; x < 10; x++) store.drag({ x, y: 1 });
    await Bun.sleep(0);
    expect(repaints).toBe(1);
  });

  test("a resize forgets the remembered rows and the selection (the text reflows)", () => {
    const store = new SelectionStore();
    store.transformOutput(screenFor(store, 0));
    store.press({ x: 0, y: 0 });
    store.drag({ x: 4, y: 0 });
    store.setViewport({ top: 0, height: 5, scrollTop: 0, contentHeight: 30, width: 60 }, () => {});
    store.transformOutput(TRANSCRIPT.slice(0, 5).join("\n"));
    expect(store.release()).toBe("");
  });

  test("reset forgets everything (used by /clear)", () => {
    const store = new SelectionStore();
    store.transformOutput(screenFor(store, 0));
    store.press({ x: 0, y: 0 });
    store.drag({ x: 4, y: 0 });
    store.reset();
    expect(store.release()).toBe("");
  });
});
