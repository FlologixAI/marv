import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import stringWidth from "string-width";
import { FRAMES, GREETING, IDLE_LOOP, Martian } from "../src/ui/Martian.tsx";
import { Welcome } from "../src/ui/Welcome.tsx";

afterEach(cleanup);

// Ink trims trailing spaces from each rendered line.
const shown = (name: keyof typeof FRAMES) => FRAMES[name].map((row) => row.trimEnd()).join("\n");

describe("Martian frames", () => {
  test("every frame has the same size, so the banner never shifts while animating", () => {
    const [first, ...rest] = Object.values(FRAMES);
    const width = stringWidth(first![0]!);
    for (const frame of [first!, ...rest]) {
      expect(frame).toHaveLength(first!.length);
      for (const row of frame) expect(stringWidth(row)).toBe(width);
    }
  });

  test("the animation scripts only use frames that exist", () => {
    for (const step of [...GREETING, ...IDLE_LOOP]) {
      expect(FRAMES).toHaveProperty(step.frame);
      expect(step.ms).toBeGreaterThan(0);
    }
  });
});

describe("Martian", () => {
  test("starts on the first greeting frame and then moves", async () => {
    const { lastFrame } = render(<Martian />);
    expect(lastFrame()).toBe(shown(GREETING[0]!.frame));
    await Bun.sleep(GREETING[0]!.ms + 50);
    expect(lastFrame()).toBe(shown(GREETING[1]!.frame));
  });

  test("holds still when animation is off", async () => {
    const { lastFrame } = render(<Martian animate={false} />);
    await Bun.sleep(GREETING[0]!.ms + 50);
    expect(lastFrame()).toBe(shown("idle"));
  });
});

test("the welcome banner shows the martian beside the text", () => {
  const { lastFrame } = render(<Welcome version="9.9.9" cwd="~/x" animate={false} />);
  const frame = lastFrame()!;
  expect(frame).toContain("│ ◉ ◉ │");
  const textRow = frame.split("\n").find((line) => line.includes("Welcome to Ekko"));
  expect(textRow).toMatch(/[│╭╰].*[│╮╯].*Welcome to Ekko v9\.9\.9/);
  expect(frame).toContain("cwd: ~/x");
});
