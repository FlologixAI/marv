import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAgent, GENERAL_PURPOSE, loadAgents, SUBAGENT_TOOLS } from "../src/agents.ts";

let root: string;
let home: string;

async function agentFile(base: string, file: string, content: string) {
  const dir = join(base, ".marv", "agents");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content);
}
const md = (fields: string, body = "You are a reviewer.") => `---\n${fields}\n---\n\n${body}\n`;

// The shape of superpowers' agents/code-reviewer.md (multi-line description with examples, model: inherit).
const SUPERPOWERS_REVIEWER = `---
name: code-reviewer
description: |
  Use this agent when a major project step has been completed and needs to be reviewed against the original plan and coding standards. Examples: <example>Context: The user finished step 3. user: "Done with step 3" assistant: "Let me use the code-reviewer agent" <commentary>A step is complete.</commentary></example>
model: inherit
---

You are a Senior Code Reviewer with expertise in software architecture.
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-agents-root-"));
  home = await mkdtemp(join(tmpdir(), "marv-agents-home-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("loadAgents", () => {
  test("general-purpose is always there, with every subagent tool", async () => {
    const { agents, problems } = await loadAgents({ root, home });
    expect(problems).toEqual([]);
    expect(agents).toEqual([GENERAL_PURPOSE]);
    expect(GENERAL_PURPOSE.tools).toEqual(SUBAGENT_TOOLS);
    expect(SUBAGENT_TOOLS).not.toContain("agent");
    expect(SUBAGENT_TOOLS).not.toContain("memory");
  });

  test("reads project and personal agents; the project's wins a name clash", async () => {
    await agentFile(home, "reviewer.md", md("name: reviewer\ndescription: Personal reviewer."));
    await agentFile(home, "tester.md", md("name: tester\ndescription: Runs tests."));
    await agentFile(root, "reviewer.md", md("name: reviewer\ndescription: Project reviewer."));
    const { agents } = await loadAgents({ root, home });
    expect(agents.map((a) => [a.name, a.source, a.description])).toEqual([
      ["general-purpose", "built-in", GENERAL_PURPOSE.description],
      ["reviewer", "project", "Project reviewer."],
      ["tester", "personal", "Runs tests."],
    ]);
    expect(agents[1]!.body).toBe("You are a reviewer.");
  });

  test("superpowers' code-reviewer.md loads unchanged", async () => {
    await agentFile(home, "code-reviewer.md", SUPERPOWERS_REVIEWER);
    const { agents, problems } = await loadAgents({ root, home });
    expect(problems).toEqual([]);
    const reviewer = agents.find((a) => a.name === "code-reviewer")!;
    expect(reviewer.description).toStartWith("Use this agent when a major project step");
    expect(reviewer.model).toBeUndefined(); // inherit = the session's model
    expect(reviewer.tools).toEqual(SUBAGENT_TOOLS);
    expect(reviewer.body).toStartWith("You are a Senior Code Reviewer");
  });

  test("tools: Marv's names or Claude Code's, as a list or a comma string", async () => {
    await agentFile(root, "a.md", md("name: a\ndescription: A.\ntools: Read, Grep, glob"));
    await agentFile(root, "b.md", md("name: b\ndescription: B.\ntools:\n  - read_file\n  - Bash"));
    const { agents } = await loadAgents({ root, home });
    expect(agents.find((x) => x.name === "a")!.tools).toEqual(["read_file", "grep", "glob"]);
    expect(agents.find((x) => x.name === "b")!.tools).toEqual(["read_file", "bash"]);
  });

  test("a model other than inherit is kept", async () => {
    await agentFile(root, "fast.md", md("name: fast\ndescription: Quick lookups.\nmodel: qwen3.5:4b"));
    expect((await loadAgents({ root, home })).agents.find((a) => a.name === "fast")!.model).toBe("qwen3.5:4b");
  });

  test("broken files are skipped and reported", async () => {
    await agentFile(root, "nodesc.md", md("name: nodesc"));
    await agentFile(root, "badtool.md", md("name: badtool\ndescription: X.\ntools: read_file, WebSearch"));
    await agentFile(root, "nested.md", md("name: nested\ndescription: X.\ntools: agent"));
    await agentFile(root, "Bad Name.md", md('name: "Bad Name"\ndescription: X.'));
    await agentFile(root, "notes.txt", "not an agent");
    const { agents, problems } = await loadAgents({ root, home });
    expect(agents.map((a) => a.name)).toEqual(["general-purpose"]);
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain(".marv/agents/nodesc.md needs a description");
    expect(problems.join("\n")).toContain('can\'t use "WebSearch"');
    expect(problems.join("\n")).toContain('can\'t use "agent"');
    expect(problems.join("\n")).toContain('the name "Bad Name"');
  });
});

describe("findAgent", () => {
  const reviewer = { ...GENERAL_PURPOSE, name: "code-reviewer", source: "personal" as const };
  test("by exact name, or without a plugin prefix like superpowers:", () => {
    const agents = [GENERAL_PURPOSE, reviewer];
    expect(findAgent(agents, "code-reviewer")).toBe(reviewer);
    expect(findAgent(agents, "superpowers:code-reviewer")).toBe(reviewer);
    expect(findAgent(agents, "nope")).toBeUndefined();
  });
});
