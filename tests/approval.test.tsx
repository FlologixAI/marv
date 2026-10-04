import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import type { ApprovalRequest } from "../src/tools/types.ts";
import { Approval } from "../src/ui/Approval.tsx";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const tick = (ms = 30) => Bun.sleep(ms);

afterEach(cleanup);

const EDIT: ApprovalRequest = {
  tool: "edit_file",
  label: "src/greet.ts",
  scope: { key: "files", description: "file changes" },
  preview: {
    title: "Edit src/greet.ts",
    diff: [
      { kind: "ctx", text: "export function greet(name: string) {" },
      { kind: "del", text: "  return `Hello, ${name}!`;" },
      { kind: "add", text: "  return `Hi, ${name}!`;" },
      { kind: "ctx", text: "}" },
    ],
  },
};

const COMMAND: ApprovalRequest = {
  tool: "bash",
  label: "bun test",
  scope: { key: "bash:bun test", description: "this exact command" },
  preview: { title: "Run a command", command: "bun test", note: "sandboxed · no network" },
};

describe("Approval", () => {
  test("shows the change as a diff and the three choices", () => {
    const { lastFrame } = render(<Approval request={EDIT} onDecide={() => {}} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Edit src/greet.ts");
    expect(frame).toContain("-   return `Hello, ${name}!`;");
    expect(frame).toContain("+   return `Hi, ${name}!`;");
    expect(frame).toContain("Yes");
    expect(frame).toContain("don't ask again for file changes this session");
    expect(frame).toContain("No");
  });

  test("shows a command with its sandbox note", () => {
    const frame = render(<Approval request={COMMAND} onDecide={() => {}} />).lastFrame()!;
    expect(frame).toContain("$ bun test");
    expect(frame).toContain("sandboxed · no network");
  });

  test("shows plain text (like a memory) without the $ prompt", () => {
    const request = { ...COMMAND, preview: { title: "Remember (personal, all projects)", text: "Prefers short answers." } };
    const frame = render(<Approval request={request} onDecide={() => {}} />).lastFrame()!;
    expect(frame).toContain("Prefers short answers.");
    expect(frame).not.toContain("$ Prefers");
  });

  test("shows a warning when a command isn't sandboxed", () => {
    const request = { ...COMMAND, preview: { ...COMMAND.preview, note: undefined, warning: "runs WITHOUT a sandbox" } };
    expect(render(<Approval request={request} onDecide={() => {}} />).lastFrame()).toContain("runs WITHOUT a sandbox");
  });

  test("a long diff is cut, saying how much more there is", () => {
    const diff = Array.from({ length: 60 }, (_, i) => ({ kind: "add" as const, text: `line ${i}` }));
    const frame = render(<Approval request={{ ...EDIT, preview: { title: "Create big.ts", diff } }} onDecide={() => {}} />).lastFrame()!;
    expect(frame).toContain("line 0");
    expect(frame).not.toContain("line 59");
    expect(frame).toMatch(/… \d+ more lines/);
  });

  test.each([
    [[ENTER], "yes"],
    [[DOWN, ENTER], "always"],
    [[DOWN, DOWN, ENTER], "no"],
  ])("keys %j decide %s", async (keys, decision) => {
    const onDecide = mock();
    const { stdin } = render(<Approval request={EDIT} onDecide={onDecide} />);
    for (const key of keys) {
      stdin.write(key);
      await tick();
    }
    expect(onDecide).toHaveBeenCalledWith(decision);
  });

  test("Esc means no", async () => {
    const onDecide = mock();
    const { stdin } = render(<Approval request={EDIT} onDecide={onDecide} />);
    stdin.write(ESC);
    await tick(100); // a lone ESC is held briefly to tell it apart from escape sequences
    expect(onDecide).toHaveBeenCalledWith("no");
  });
});
