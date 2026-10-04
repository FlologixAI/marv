import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions, subagentPrompt, systemPrompt } from "../src/prompt.ts";

const DATE = new Date("2026-10-03T12:00:00Z");

describe("systemPrompt", () => {
  test("says who Marv is, where it is, and which tools it has", () => {
    const prompt = systemPrompt({ cwd: "~/proj", date: DATE, tools: ["read_file", "glob", "grep"] });
    expect(prompt).toContain("You are Marv");
    expect(prompt).toContain("Working directory: ~/proj");
    expect(prompt).toContain("2026-10-03");
    expect(prompt).toContain("read_file, glob, grep");
    expect(prompt).not.toContain("AGENTS.md");
  });

  test("appends the project's AGENTS.md", () => {
    const prompt = systemPrompt({ cwd: "~/proj", date: DATE, tools: [], instructions: "Use tabs. Run bun test." });
    expect(prompt).toEndWith("# Project instructions (from AGENTS.md)\n\nUse tabs. Run bun test.");
  });

  test("lists skills by name and description only", () => {
    const prompt = systemPrompt({ cwd: "~/proj", date: DATE, tools: ["skill"], skills: [{ name: "review", description: "Review code for bugs." }] });
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("- review: Review code for bugs.");
    expect(systemPrompt({ cwd: "~/proj", date: DATE, tools: [] })).not.toContain("# Skills");
  });

  test("includes memory when given", () => {
    const prompt = systemPrompt({ cwd: "~/proj", date: DATE, tools: ["memory"], memory: { personal: ["Prefers short answers."], project: [] } });
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("- Prefers short answers.");
    expect(systemPrompt({ cwd: "~/proj", date: DATE, tools: [] })).not.toContain("# Memory");
  });

  test("is identical for identical inputs (the prompt cache depends on it)", () => {
    const args = { cwd: "~/proj", date: DATE, tools: ["read_file"], instructions: "x" };
    expect(systemPrompt(args)).toBe(systemPrompt({ ...args }));
  });
});

describe("loadInstructions", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "marv-agents-md-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test("reads AGENTS.md from the project root, trimmed", async () => {
    await writeFile(join(root, "AGENTS.md"), "\n# Rules\nUse tabs.\n\n");
    expect(await loadInstructions(root)).toBe("# Rules\nUse tabs.");
  });

  test("is undefined when there's no AGENTS.md (or it's empty)", async () => {
    expect(await loadInstructions(root)).toBeUndefined();
    await writeFile(join(root, "AGENTS.md"), "  \n");
    expect(await loadInstructions(root)).toBeUndefined();
  });

  test("cuts off a huge file so it can't eat the context window", async () => {
    await writeFile(join(root, "AGENTS.md"), "x".repeat(50_000));
    const text = (await loadInstructions(root))!;
    expect(text.length).toBeLessThan(21_000);
    expect(text).toEndWith("(AGENTS.md was cut off here: it's longer than 20000 characters.)");
  });
});

describe("agents in the system prompt", () => {
  test("lists agent types by name and description, before the project instructions", () => {
    const prompt = systemPrompt({ cwd: "~/proj", date: DATE, tools: ["agent"], agents: [{ name: "code-reviewer", description: "Review a finished step." }], instructions: "Use tabs." });
    expect(prompt).toContain("# Agents");
    expect(prompt).toContain("- code-reviewer: Review a finished step.");
    expect(prompt).toContain('isolation: "worktree"');
    expect(prompt).toEndWith("Use tabs.");
    expect(systemPrompt({ cwd: "~/proj", date: DATE, tools: [] })).not.toContain("# Agents");
  });
});

describe("subagentPrompt", () => {
  const base = { cwd: "~/proj", date: DATE, tools: ["read_file", "grep"], body: "You are a Senior Code Reviewer." };

  test("starts with the type's instructions and explains the report", () => {
    const prompt = subagentPrompt(base);
    expect(prompt).toStartWith("You are a Senior Code Reviewer.");
    expect(prompt).toContain("Your final message is your report");
    expect(prompt).toContain("Working directory: ~/proj");
    expect(prompt).toContain("read_file, grep");
    expect(prompt).not.toContain("# Memory");
    expect(prompt).not.toContain("worktree");
  });

  test("general-purpose (no body) gets a generic role", () => {
    expect(subagentPrompt({ ...base, body: "" })).toStartWith("You are a general-purpose coding agent.");
  });

  test("in a worktree: names the branch, says dependencies are missing and that Marv commits", () => {
    const prompt = subagentPrompt({ ...base, worktree: { branch: "marv/task-2-ab12", base: "abc1234" } });
    expect(prompt).toContain("branch marv/task-2-ab12 (started from abc1234)");
    expect(prompt).toContain("node_modules");
    expect(prompt).toContain("Marv commits everything you changed");
  });

  test("includes skills and AGENTS.md like the main prompt", () => {
    const prompt = subagentPrompt({ ...base, skills: [{ name: "tdd", description: "Test first." }], instructions: "Use tabs." });
    expect(prompt).toContain("- tdd: Test first.");
    expect(prompt).toEndWith("# Project instructions (from AGENTS.md)\n\nUse tabs.");
  });
});
