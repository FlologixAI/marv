import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { Welcome } from "../src/ui/Welcome.tsx";

afterEach(cleanup);

test("the welcome banner shows the ekko bot beside the text", () => {
  const { lastFrame } = render(<Welcome version="9.9.9" cwd="~/x" />);
  const lines = lastFrame()!.split("\n");
  // Antenna, then the head rows sharing a line with the text.
  expect(lines[1]).toContain("▖");
  expect(lines[2]).toContain("▟███▙");
  expect(lines[2]).toContain("Welcome to ekko");
  expect(lines[3]).toContain("█●█●█");
  expect(lines[3]).toContain("/help for commands");
  expect(lines[4]).toContain("▜███▛");
  expect(lines[4]).toContain("cwd: ~/x");
});
