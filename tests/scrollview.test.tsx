import { afterEach, describe, expect, test } from "bun:test";
import { Box, Text } from "ink";
import { cleanup, render } from "ink-testing-library";
import { mouse } from "../src/mouse.ts";
import { ScrollView } from "../src/ui/ScrollView.tsx";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const tick = (ms = 50) => Bun.sleep(ms);

afterEach(cleanup);

function Lines({ count, height = 4, followKey = 0, hidden = false }: { count: number; height?: number; followKey?: number; hidden?: boolean }) {
  return (
    <Box height={height} flexDirection="column">
      <ScrollView followKey={followKey} hidden={hidden}>
        {Array.from({ length: count }, (_, i) => (
          <Text key={i}>line {i + 1}</Text>
        ))}
      </ScrollView>
    </Box>
  );
}

const visible = (frame: string | undefined) => (frame ?? "").split("\n").filter((l) => l.trim());

describe("ScrollView", () => {
  test("starts at the bottom, showing the newest lines", async () => {
    const { lastFrame } = render(<Lines count={10} />);
    await tick();
    expect(visible(lastFrame())).toEqual(["line 7", "line 8", "line 9", "line 10"]);
  });

  test("keeps following the bottom as content grows", async () => {
    const { lastFrame, rerender } = render(<Lines count={10} />);
    await tick();
    rerender(<Lines count={12} />);
    await tick();
    expect(visible(lastFrame()).at(-1)).toBe("line 12");
  });

  test("page up scrolls back, page down returns to the bottom", async () => {
    const { lastFrame, stdin } = render(<Lines count={10} />);
    await tick();
    stdin.write(PAGE_UP);
    await tick();
    expect(visible(lastFrame())[0]).toBe("line 4");

    stdin.write(PAGE_DOWN);
    await tick();
    expect(visible(lastFrame()).at(-1)).toBe("line 10");
  });

  test("stays put while scrolled up, even as content grows", async () => {
    const { lastFrame, stdin, rerender } = render(<Lines count={10} />);
    await tick();
    stdin.write(PAGE_UP);
    await tick();
    rerender(<Lines count={12} />);
    await tick();
    expect(visible(lastFrame())[0]).toBe("line 4");
  });

  test("the mouse wheel scrolls 3 rows per notch, gliding one row per frame", async () => {
    const { lastFrame, frames } = render(<Lines count={10} />);
    await tick();
    mouse.emit("event", { type: "scroll", step: -1 });
    await tick(120);
    expect(visible(lastFrame())[0]).toBe("line 4");
    // It passed through the rows in between instead of jumping.
    const tops = frames.map((frame) => visible(frame)[0]);
    expect(tops).toContain("line 6");
    expect(tops).toContain("line 5");

    mouse.emit("event", { type: "scroll", step: 1 });
    await tick(120);
    expect(visible(lastFrame()).at(-1)).toBe("line 10");
  });

  test("a fast flick adds up, and the glide catches up quickly", async () => {
    const { lastFrame } = render(<Lines count={60} />);
    await tick();
    for (let i = 0; i < 6; i++) mouse.emit("event", { type: "scroll", step: -1 }); // 18 rows
    await tick(200);
    expect(visible(lastFrame())[0]).toBe("line 39"); // bottom was lines 57-60; 18 rows up
  });

  test("a direction change cancels the rest of the glide", async () => {
    const { lastFrame } = render(<Lines count={60} />);
    await tick();
    for (let i = 0; i < 6; i++) mouse.emit("event", { type: "scroll", step: -1 });
    mouse.emit("event", { type: "scroll", step: 1 }); // changed my mind
    await tick(200);
    // Only the 3 rows of the last notch remain to travel, back toward the bottom: it ends at the bottom.
    expect(visible(lastFrame()).at(-1)).toBe("line 60");
  });

  test("a new followKey jumps back to the bottom", async () => {
    const { lastFrame, stdin, rerender } = render(<Lines count={10} />);
    await tick();
    stdin.write(PAGE_UP);
    await tick();
    rerender(<Lines count={10} followKey={1} />);
    await tick();
    expect(visible(lastFrame()).at(-1)).toBe("line 10");
  });

  test("hidden and shown again (a subagent's view closing), it's where it was: no flash of the top, no jump", async () => {
    const { lastFrame, frames, stdin, rerender } = render(<Lines count={30} />);
    await tick();
    stdin.write(PAGE_UP);
    stdin.write(PAGE_UP);
    stdin.write(PAGE_UP);
    stdin.write(PAGE_UP);
    stdin.write(PAGE_UP);
    await tick();
    const before = visible(lastFrame());
    expect(before[0]).toBe("line 12");
    mouse.emit("event", { type: "scroll", step: -1 }); // a wheel glide still going when the view opens
    rerender(<Lines count={30} hidden />);
    await tick(150);
    const shownFrom = frames.length;
    rerender(<Lines count={30} />);
    await tick(100);
    const after = frames.slice(shownFrom).map((f) => visible(f)[0]);
    expect(after.every((first) => first !== "line 1")).toBe(true); // never the top
    expect(visible(lastFrame())[0]).not.toBe("line 27"); // not snapped to the bottom
  });
});
