import { describe, expect, test } from "bun:test";
import { isCommand, runCommand as run, type CommandContext } from "../src/commands/index.ts";

const ctx: CommandContext = {
  config: {
    provider: "openrouter",
    model: "z-ai/glm-5.3",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or-v1-abcdefghijklmnop-wxyz",
    apiKeySource: "env",
    thinking: false,
    contextLength: 32768,
    sandbox: true,
  },
  configPath: "~/.marv/config.json",
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
    expect(action.text).toContain("Provider:  OpenRouter");
    expect(action.text).toContain("Endpoint:  https://openrouter.ai/api/v1");
    expect(action.text).toContain("sk-or-v1-a…wxyz (from OPENROUTER_API_KEY)");
    expect(action.text).not.toContain("abcdefghijklmnop");
  });

  test("/config says when no key is needed (Ollama)", () => {
    const action = run("/config", { ...ctx, config: { provider: "ollama", model: "qwen3.5:9b", baseUrl: "http://localhost:11434", thinking: false, contextLength: 32768, sandbox: true } });
    expect(action).toMatchObject({ type: "print", text: expect.stringContaining("API key:   not needed") });
  });

  test("/model opens the picker, or switches straight to a given id", () => {
    expect(runCommand("/model")).toEqual({ type: "model" });
    expect(runCommand("/model openai/gpt-5.6-sol")).toEqual({ type: "model", id: "openai/gpt-5.6-sol" });
  });

  test("/sandbox shows the sandbox, or turns it on and off", () => {
    expect(runCommand("/sandbox off")).toEqual({ type: "sandbox", on: false });
    expect(runCommand("/sandbox on")).toEqual({ type: "sandbox", on: true });
    expect(runCommand("/sandbox")).toMatchObject({ type: "print", text: expect.stringMatching(/^Sandbox: on/) });
    expect(runCommand("/sandbox maybe")).toMatchObject({ type: "print", isError: true });
  });

  test("/think toggles, or takes on/off", () => {
    expect(runCommand("/think")).toEqual({ type: "thinking", on: true });
    expect(run("/think", { ...ctx, config: { ...ctx.config, thinking: true } })).toEqual({ type: "thinking", on: false });
    expect(runCommand("/think off")).toEqual({ type: "thinking", on: false });
    expect(runCommand("/think maybe")).toMatchObject({ type: "print", isError: true });
  });

  test("/setup opens the setup screen", () => {
    expect(runCommand("/setup")).toEqual({ type: "setup" });
  });

  test("unknown commands return an error", () => {
    const action = runCommand("/nope");
    expect(action).toMatchObject({ type: "print", isError: true });
  });
});
