import { describe, expect, test } from "bun:test";
import { isCommand, runCommand } from "../src/commands/index.ts";

describe("slash commands", () => {
  test("detects commands by leading slash", () => {
    expect(isCommand("/help")).toBe(true);
    expect(isCommand("hello /help")).toBe(false);
  });

  test("/help lists every command", () => {
    const action = runCommand("/help");
    expect(action.type).toBe("print");
    if (action.type !== "print") return;
    expect(action.text).toContain("/help");
    expect(action.text).toContain("/clear");
    expect(action.text).toContain("/exit");
  });

  test("/clear and /exit map to actions, case-insensitively", () => {
    expect(runCommand("/clear")).toEqual({ type: "clear" });
    expect(runCommand("/EXIT")).toEqual({ type: "exit" });
  });

  test("unknown commands return an error", () => {
    const action = runCommand("/nope");
    expect(action).toMatchObject({ type: "print", isError: true });
  });
});
