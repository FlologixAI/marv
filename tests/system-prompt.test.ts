import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions, systemPrompt } from "../src/prompt.ts";

const DATE = new Date("2026-10-03T12:00:00Z");

describe("systemPrompt", () => {
  test("says who Ekko is, where it is, and which tools it has", () => {
    const prompt = systemPrompt({ cwd: "~/proj", date: DATE, tools: ["read_file", "glob", "grep"] });
    expect(prompt).toContain("You are Ekko");
    expect(prompt).toContain("Working directory: ~/proj");
    expect(prompt).toContain("2026-10-03");
    expect(prompt).toContain("read_file, glob, grep");
    expect(prompt).not.toContain("AGENTS.md");
  });

  test("appends the project's AGENTS.md", () => {
    const prompt = systemPrompt({ cwd: "~/proj", date: DATE, tools: [], instructions: "Use tabs. Run bun test." });
    expect(prompt).toEndWith("# Project instructions (from AGENTS.md)\n\nUse tabs. Run bun test.");
  });

  test("is identical for identical inputs (the prompt cache depends on it)", () => {
    const args = { cwd: "~/proj", date: DATE, tools: ["read_file"], instructions: "x" };
    expect(systemPrompt(args)).toBe(systemPrompt({ ...args }));
  });
});

describe("loadInstructions", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ekko-agents-md-"));
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
