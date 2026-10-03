import { describe, expect, test } from "bun:test";
import { isCommand, runCommand as run, type CommandContext } from "../src/commands/index.ts";

const ctx: CommandContext = {
  config: { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-api03-abcdefghijklmnop-wxyz", apiKeySource: "env" },
  configPath: "~/.ekko/config.json",
};
const runCommand = (input: string) => run(input, ctx);

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

  test("/config shows a masked key and where it came from", () => {
    const action = runCommand("/config");
    if (action.type !== "print") throw new Error("expected print");
    expect(action.text).toContain("sk-ant-api…wxyz (from ANTHROPIC_API_KEY)");
    expect(action.text).not.toContain("abcdefghijklmnop");
  });

  test("/setup opens the setup screen", () => {
    expect(runCommand("/setup")).toEqual({ type: "setup" });
  });

  test("unknown commands return an error", () => {
    const action = runCommand("/nope");
    expect(action).toMatchObject({ type: "print", isError: true });
  });
});
