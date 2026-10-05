import { describe, expect, test } from "bun:test";
import { GENERAL_PURPOSE } from "../src/agents.ts";
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
    yolo: true,
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
    const action = run("/config", { ...ctx, config: { provider: "ollama", model: "qwen3.5:9b", baseUrl: "http://localhost:11434", thinking: false, contextLength: 32768, sandbox: true, yolo: true } });
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

  test("/yolo toggles, or takes on/off", () => {
    expect(runCommand("/yolo")).toEqual({ type: "yolo", on: false }); // on by default
    expect(run("/yolo", { ...ctx, config: { ...ctx.config, yolo: false } })).toEqual({ type: "yolo", on: true });
    expect(runCommand("/yolo on")).toEqual({ type: "yolo", on: true });
    expect(runCommand("/yolo maybe")).toMatchObject({ type: "print", isError: true });
    expect(runCommand("/config")).toMatchObject({ type: "print", text: expect.stringContaining("Yolo:      on") });
  });

  test("/skills lists skills, or explains how to add one", () => {
    const review = { name: "review", description: "Review code.", body: "b", dir: "/x", files: [], source: "project" as const };
    const listed = run("/skills", { ...ctx, skills: [review], skillProblems: ["bad/SKILL.md needs a description"] });
    if (listed.type !== "print") throw new Error("expected print");
    expect(listed.markdown).toBe(true); // rendered as a list, with hanging indents
    expect(listed.text).toContain("- `/review`: Review code.");
    expect(listed.text).toContain("Couldn't load:");
    expect(run("/skills", ctx)).toMatchObject({ type: "print", text: expect.stringContaining("SKILL.md") });
  });

  test("/<skill> runs that skill with the rest as its request; built-in commands win", () => {
    const review = { name: "review", description: "d", body: "b", dir: "/x", files: [], source: "project" as const };
    const help = { ...review, name: "help" };
    expect(run("/review src/app.tsx now", { ...ctx, skills: [review] })).toEqual({ type: "skill", skill: review, args: "src/app.tsx now" });
    expect(run("/help", { ...ctx, skills: [help] }).type).toBe("print");
  });

  test("/remember saves to personal memory, or to the project with project:", () => {
    expect(runCommand("/remember uses bun, not npm")).toEqual({ type: "remember", scope: "personal", text: "uses bun, not npm" });
    expect(runCommand("/remember project: tests need Ollama")).toEqual({ type: "remember", scope: "project", text: "tests need Ollama" });
    expect(runCommand("/remember")).toMatchObject({ type: "print", isError: true });
    expect(runCommand("/forget ollama")).toEqual({ type: "forget", text: "ollama" });
    expect(runCommand("/memory")).toEqual({ type: "memory" });
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
  test("/agents lists agent types and files that couldn't be loaded", () => {
    const reviewer = { ...GENERAL_PURPOSE, name: "code-reviewer", description: "Review a step.", tools: ["read_file", "grep"], model: "small", source: "personal" as const };
    const action = run("/agents", { ...ctx, agents: [GENERAL_PURPOSE, reviewer], agentProblems: ["~/.marv/agents/bad.md needs a description"] });
    expect(action).toMatchObject({ type: "print", markdown: true });
    const text = (action as { text: string }).text;
    expect(text).toContain("`general-purpose` *(built-in)*");
    expect(text).toContain("`code-reviewer` *(personal)*: Review a step.");
    expect(text).toContain("tools: read_file, grep · model: small");
    expect(text).toContain("bad.md needs a description");
  });
});
