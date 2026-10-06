import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { elapsed, ThinkingView } from "../src/ui/ThinkingView.tsx";

describe("elapsed", () => {
  test("seconds, then minutes and seconds", () => {
    expect(elapsed(0)).toBe("0s");
    expect(elapsed(12_400)).toBe("12s");
    expect(elapsed(59_999)).toBe("59s");
    expect(elapsed(65_000)).toBe("1m 05s");
    expect(elapsed(600_000)).toBe("10m 00s");
  });
});

describe("ThinkingView", () => {
  test("counts the seconds since it appeared, and the thought's tokens", async () => {
    const { lastFrame, rerender, unmount } = render(<ThinkingView thought="" />);
    expect(lastFrame()).toContain("Thinking…");
    expect(lastFrame()).not.toContain("("); // nothing to show before the first second
    await Bun.sleep(1100);
    expect(lastFrame()).toContain("Thinking… (1s)");
    rerender(<ThinkingView thought={"x".repeat(4800)} />);
    expect(lastFrame()).toContain("Thinking… (1s · ~1.2k tokens)");
    unmount();
  });
});
