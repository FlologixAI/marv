# Subagents (Milestone 9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Marv can hand a task to a subagent (a fresh run of the agent loop with its own prompt and tools), run several at once, and optionally give each its own git worktree.

**Architecture:** In-process. A new `agent` tool calls `runAgent()` again with a fresh history; `runAgent` runs consecutive `agent` calls concurrently (max 4) and appends results in call order. A worktree subagent's `ToolContext.root` is its worktree, so `resolveInProject()` and the bwrap sandbox confine it; its changes are auto-approved (except network); its sandbox shows the repo's `.git` read-only, and when it ends Marv commits its changes, removes the folder and leaves a branch for the parent to merge.

**Tech Stack:** Bun, TypeScript, Ink, zod, git worktrees, bubblewrap. Spec: `docs/superpowers/specs/2026-10-04-subagents-design.md`.

**Conventions (from CLAUDE.md):** imports use explicit `.ts`/`.tsx` extensions and `import type` for types; tests never hit the network; UI tests use `ink-testing-library`; colors only from `src/ui/theme.ts`. Run one test file with `bun test tests/<name>`; everything with `bun test`; types with `bun run typecheck`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/frontmatter.ts` | new | Parse the `---` YAML block shared by SKILL.md and agent files |
| `src/skills.ts` | modify | Use `parseFrontmatter` |
| `src/agents.ts` | new | Agent types: load `.marv/agents/*.md`, built-in `general-purpose`, lookup |
| `src/tools/types.ts` | modify | `parallel`, `needsApproval`, `usesNetwork` on `Tool`; `callId`, `readOnly`, `agentHost` on `ToolContext`; `agent`, `network` on `ApprovalRequest`; `AgentHost`, `AgentProgress` |
| `src/tools/index.ts` | modify | `runTool(call, ctx, available)`; per-call approval gate; register `agent`; `isParallelCall` |
| `src/sandbox.ts`, `src/tools/bash.ts` | modify | Extra read-only folders (a worktree's shared `.git`); bash `usesNetwork` |
| `src/agent.ts` | modify | Run consecutive parallel calls concurrently; results in call order |
| `src/prompt.ts` | modify | `# Agents` section; `subagentPrompt()` |
| `src/worktree.ts` | new | Create / inspect / finish git worktrees |
| `src/subagent.ts` | new | Run one subagent: tools, prompt, approvals, progress, report |
| `src/tools/agent.ts` | new | The `agent` tool (schema, approval preview, run) |
| `tests/fake-provider.ts` | modify | `RoutedProvider` for interleaved subagent requests |
| `patches/ink-text-input@*.patch` | new | Ignore ctrl+letter in the text box (so ctrl+o doesn't type "o") |
| `src/ui/Approval.tsx` | modify | Who's asking, how many are waiting, Esc = cancel all |
| `src/ui/MessageView.tsx`, `src/ui/Transcript.tsx`, `src/ui/StatusBar.tsx`, `src/types.ts` | modify | Live agent line, ctrl+o steps, "N agents running" |
| `src/app.tsx` | modify | Approval queue, agent host, progress batching, counts, ctrl+o |
| `src/commands/index.ts` | modify | `/agents` |
| `src/cli.tsx` | modify | Load agents, worktrees dir |
| `CLAUDE.md`, `README.md` | modify | Document it |

---

### Task 1: Shared frontmatter parser

Agent files use the same `---` YAML header as skills. Pull the parsing out of `src/skills.ts` so both use one implementation.

**Files:**
- Create: `src/frontmatter.ts`
- Modify: `src/skills.ts` (function `readSkill`)
- Test: `tests/frontmatter.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/frontmatter.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
  test("splits the YAML fields from the body", () => {
    expect(parseFrontmatter("---\nname: review\ndescription: Look for bugs.\n---\n\n# Review\n", "x.md")).toEqual({
      fields: { name: "review", description: "Look for bugs." },
      body: "# Review",
    });
  });

  test("a multi-line description (as in Claude Code agent files) is one string", () => {
    const parsed = parseFrontmatter("---\nname: r\ndescription: |\n  Line one.\n  <example>two</example>\n---\nBody", "x.md");
    expect(parsed).toEqual({ fields: { name: "r", description: "Line one.\n<example>two</example>\n" }, body: "Body" });
  });

  test("no frontmatter, or broken YAML, is an error naming the file", () => {
    expect(parseFrontmatter("# Just text", "a/SKILL.md")).toEqual({ error: expect.stringContaining("a/SKILL.md starts without") });
    expect(parseFrontmatter("---\nname: [unclosed\n---\n", "b.md")).toEqual({ error: expect.stringContaining("b.md: the frontmatter isn't valid YAML") });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/frontmatter`
Expected: FAIL, `Cannot find module '../src/frontmatter.ts'`.

- [ ] **Step 3: Write `src/frontmatter.ts`**

```ts
// YAML frontmatter: the "---" block at the top of SKILL.md and agent files,
// holding fields like name and description, followed by the instructions.

export type Frontmatter = { fields: Record<string, unknown>; body: string } | { error: string };

/** `shown` is how the file is named in problems ("~/.marv/skills/x/SKILL.md"). */
export function parseFrontmatter(text: string, shown: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { error: `${shown} starts without a --- frontmatter block (name and description).` };
  let meta: unknown;
  try {
    meta = Bun.YAML.parse(match[1]!);
  } catch (err) {
    return { error: `${shown}: the frontmatter isn't valid YAML (${(err as Error).message}).` };
  }
  const fields = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  return { fields, body: text.slice(match[0].length).trim() };
}
```

- [ ] **Step 4: Use it in `src/skills.ts`**

Add `import { parseFrontmatter } from "./frontmatter.ts";` and replace the start of `readSkill` (from `const text = …` through `const fields = …`) and the `let body = …` line:

```ts
async function readSkill(dir: string, folder: string, source: Skill["source"], shown: string): Promise<Skill | string> {
  const parsed = parseFrontmatter(await Bun.file(join(dir, "SKILL.md")).text(), shown);
  if ("error" in parsed) return parsed.error;
  const { fields } = parsed;
  const name = typeof fields.name === "string" ? fields.name.trim() : folder;
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!NAME.test(name)) return `${shown}: the name "${name}" should be lowercase letters, digits and dashes.`;
  if (!description) return `${shown} needs a description: it's how the model knows when to use the skill.`;

  let body = parsed.body;
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n\n(SKILL.md was cut off here: it's longer than ${MAX_BODY_CHARS} characters.)`;
  return { name, description, body, dir, files: listFiles(dir), source };
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/frontmatter tests/skills`
Expected: all PASS (the skills tests prove the refactor kept behavior).

- [ ] **Step 6: Commit**

```bash
git add src/frontmatter.ts src/skills.ts tests/frontmatter.test.ts
git commit -m "Share the frontmatter parser (for agent files next)"
```

---

### Task 2: Agent types

**Files:**
- Create: `src/agents.ts`
- Test: `tests/agents.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/agents.test.ts`:
```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/agents`
Expected: FAIL, `Cannot find module '../src/agents.ts'`.

- [ ] **Step 3: Write `src/agents.ts`**

```ts
// Agent types: the kinds of subagent Marv can start, as Markdown files.
//
//   .marv/agents/<name>.md      (the project's)
//   ~/.marv/agents/<name>.md    (your personal ones)
//
// YAML frontmatter (name, description, optionally tools and model), then the
// agent's own instructions, which start its system prompt. The format matches
// Claude Code's agent files, so ones written for it (like superpowers'
// code-reviewer.md) work unchanged. Like skills, only names and descriptions
// go into the main system prompt; the model picks a type when it starts one.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export interface AgentType {
  name: string;
  description: string;
  /** Its own instructions ("You are a code reviewer…"); empty for general-purpose. */
  body: string;
  /** The tools it may use (Marv's names). */
  tools: string[];
  /** A model on the same provider; undefined means the session's model. */
  model?: string;
  source: "built-in" | "project" | "personal";
}

/**
 * What subagents may use. Never `agent` (no subagents of subagents: no runaway
 * recursion) or `memory` (memory outlives the session, so only the main agent
 * changes it, with the user's approval).
 */
export const SUBAGENT_TOOLS = ["read_file", "glob", "grep", "skill", "edit_file", "write_file", "bash"];

/** Claude Code's tool names, so agent files written for it work here. */
const ALIASES: Record<string, string> = {
  Read: "read_file",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit_file",
  Write: "write_file",
  Bash: "bash",
  Skill: "skill",
};

export const GENERAL_PURPOSE: AgentType = {
  name: "general-purpose",
  description: "Any self-contained task: research across many files, implementing one planned task, running and fixing tests.",
  body: "",
  tools: SUBAGENT_TOOLS,
  source: "built-in",
};

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY_CHARS = 50_000;

export const agentsDir = (base: string) => join(base, ".marv", "agents");

function parseTools(value: unknown, shown: string): string[] | string {
  if (value === undefined || value === null) return SUBAGENT_TOOLS;
  const list = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",") : null;
  if (!list) return `${shown}: tools should be a list of tool names.`;
  const tools: string[] = [];
  for (const raw of list.map((t) => t.trim()).filter(Boolean)) {
    const name = ALIASES[raw] ?? raw;
    if (!SUBAGENT_TOOLS.includes(name)) return `${shown}: subagents can't use "${raw}". They can use: ${SUBAGENT_TOOLS.join(", ")}.`;
    if (!tools.includes(name)) tools.push(name);
  }
  return tools;
}

async function readAgent(path: string, file: string, source: AgentType["source"], shown: string): Promise<AgentType | string> {
  const parsed = parseFrontmatter(await Bun.file(path).text(), shown);
  if ("error" in parsed) return parsed.error;
  const { fields } = parsed;
  const name = typeof fields.name === "string" ? fields.name.trim() : file.replace(/\.md$/, "");
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!NAME.test(name)) return `${shown}: the name "${name}" should be lowercase letters, digits and dashes.`;
  if (!description) return `${shown} needs a description: it's how the model knows when to use the agent.`;
  const tools = parseTools(fields.tools, shown);
  if (typeof tools === "string") return tools;
  const rawModel = typeof fields.model === "string" ? fields.model.trim() : "";
  let body = parsed.body;
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n\n(${file} was cut off here: it's longer than ${MAX_BODY_CHARS} characters.)`;
  return { name, description, body, tools, model: rawModel && rawModel !== "inherit" ? rawModel : undefined, source };
}

/** Built-in, then personal, then project agents (later wins a name clash). Skips broken ones, saying why. */
export async function loadAgents({ root, home }: { root: string; home: string }): Promise<{ agents: AgentType[]; problems: string[] }> {
  const byName = new Map<string, AgentType>([[GENERAL_PURPOSE.name, GENERAL_PURPOSE]]);
  const problems: string[] = [];
  const sources = [
    { base: home, source: "personal" as const, prefix: "~/" },
    { base: root, source: "project" as const, prefix: "" },
  ];
  for (const { base, source, prefix } of sources) {
    const dir = agentsDir(base);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      const result = await readAgent(join(dir, file), file, source, `${prefix}.marv/agents/${file}`);
      if (typeof result === "string") problems.push(result);
      else byName.set(result.name, result);
    }
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/**
 * Finds a type by name. Skills written for Claude Code name plugin agents with
 * a prefix ("superpowers:code-reviewer"), so that's tried without it too.
 */
export function findAgent(agents: AgentType[], name: string): AgentType | undefined {
  const exact = agents.find((a) => a.name === name);
  if (exact || !name.includes(":")) return exact;
  const bare = name.slice(name.lastIndexOf(":") + 1);
  return agents.find((a) => a.name === bare);
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/agents`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents.ts tests/agents.test.ts
git commit -m "Agent types: .marv/agents/*.md plus a built-in general-purpose"
```

---

### Task 3: Tool interface: per-call approval, network flag, restricted tool lists

Subagents need three things from the tool layer: (1) `runTool` limited to the subagent's own tools (a model can name a tool it wasn't offered; without a limit, a subagent could call `memory`), (2) one tool (`agent`) that needs approval for some inputs only, (3) approval requests that say whether they reach the network. This task also defines the `AgentHost` types later tasks use.

**Files:**
- Modify: `src/tools/types.ts`, `src/tools/index.ts`, `src/tools/bash.ts`
- Test: `tests/tools.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/tools.test.ts`; add `import { z } from "zod";`, `import { readFile } from "../src/tools/read-file.ts";` and `import type { ApprovalRequest, Tool } from "../src/tools/types.ts";` at the top if missing; the file's existing `root` temp dir is reused, check its name in `beforeEach`)

```ts
describe("runTool: subagent support", () => {
  const sometimes: Tool = {
    name: "sometimes",
    description: "Needs approval only when asked to.",
    input: z.object({ ask: z.boolean() }),
    label: () => "x",
    needsApproval: ({ ask }: { ask: boolean }) => ask,
    preview: async () => ({ title: "Sometimes" }),
    run: async (_input, ctx) => ({ output: `ran as ${ctx.callId}`, summary: "ok" }),
  };
  const call = (name: string, args: unknown, id = "c1") => ({ id, name, arguments: JSON.stringify(args) });

  test("only the tools in `available` can be called", async () => {
    const result = await runTool(call("memory", { action: "add", text: "x" }), { root }, [readFile as Tool]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Unknown tool "memory". Available tools: read_file.');
  });

  test("needsApproval decides per call, and run() gets the call's id", async () => {
    const asked: ApprovalRequest[] = [];
    const ctx = { root, approve: async (r: ApprovalRequest) => (asked.push(r), "yes" as const) };
    expect((await runTool(call("sometimes", { ask: false }), ctx, [sometimes])).output).toBe("ran as c1");
    expect(asked).toHaveLength(0);
    expect((await runTool(call("sometimes", { ask: true }, "c2"), ctx, [sometimes])).output).toBe("ran as c2");
    expect(asked).toHaveLength(1);
  });

  test("a bash call with network: true is flagged in its approval request", async () => {
    const asked: ApprovalRequest[] = [];
    const approve = async (r: ApprovalRequest) => (asked.push(r), "no" as const);
    await runTool(call("bash", { command: "curl example.com", network: true }), { root, approve });
    await runTool(call("bash", { command: "ls" }), { root, approve });
    expect(asked.map((r) => r.network)).toEqual([true, undefined]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/tools`
Expected: FAIL (the `available` argument is ignored: "memory" runs or says a different message; `needsApproval` not honored; `network` undefined).

- [ ] **Step 3: Extend `src/tools/types.ts`**

Add these imports at the top:
```ts
import type { AgentType } from "../agents.ts";
import type { Provider, Usage } from "../provider/types.ts";
```

Add two fields to `ApprovalRequest`:
```ts
  /** Which subagent is asking ("implementer · Task 2"); absent for the main agent. */
  agent?: string;
  /** The action can reach the network (bash with network: true). */
  network?: boolean;
```

Add to `ToolContext`:
```ts
  /** The id of the call being run (set by runTool). */
  callId?: string;
  /** More folders bash may write to besides root: a worktree's shared .git, so commits work. */
  writable?: string[];
  /** Lets the agent tool start subagents. Only the main agent has one, so subagents can't start subagents. */
  agentHost?: AgentHost;
```

Add to `Tool` (after `kind`):
```ts
  /** Calls of this tool that come together in one reply run at the same time (subagents). */
  parallel?: boolean;
  /** Overrides `kind` for one call: whether it needs the user's approval. */
  needsApproval?(input: z.infer<S>): boolean;
  /** Whether this call can reach the network (approvals inside a worktree still ask then). */
  usesNetwork?(input: z.infer<S>): boolean;
```

Append at the end of the file:
```ts
/** A running subagent's state, for its transcript entry. */
export interface AgentProgress {
  /** "worktree marv/x-1a2b · 3 tools · read_file src/a.ts" */
  line: string;
  /** Its finished tool calls, newest last ("read_file src/a.ts · 120 lines"). */
  steps: string[];
}

/** What the agent tool needs from the session to start subagents. */
export interface AgentHost {
  agents: AgentType[];
  /** The session's provider, or a new one when an agent type names another model. */
  providerFor(model?: string): Provider;
  /** For the subagent's system prompt. */
  cwd: string;
  instructions?: string;
  /** Where worktrees go (~/.marv/worktrees/<project>); without it, isolation isn't available. */
  worktreesDir?: string;
  /** A subagent's request, for the session's tokens and cost. */
  onUsage(usage: Usage): void;
  onProgress(callId: string, progress: AgentProgress): void;
}
```

- [ ] **Step 4: Update `runTool` in `src/tools/index.ts`**

Replace the function with:
```ts
/**
 * Runs a call. Never throws: every failure becomes a result the model can read
 * and recover from. `available` is what this agent was offered (a subagent
 * gets fewer tools); anything else is unknown, even if the model names it.
 */
export async function runTool(call: ToolCall, ctx: ToolContext, available: Tool[] = tools): Promise<ToolResult & { label: string }> {
  const tool = available.find((t) => t.name === call.name);
  const fail = (output: string, label = call.name) => ({ output, summary: "error", isError: true, label });
  if (!tool) return fail(`Unknown tool "${call.name}". Available tools: ${available.map((t) => t.name).join(", ")}.`);

  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments || "{}");
  } catch {
    return fail(`The arguments for ${call.name} are not valid JSON: ${call.arguments}`);
  }
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) return fail(`Invalid input for ${call.name}:\n${z.prettifyError(parsed.error)}`);

  const label = shortLabel(tool.label(parsed.data), ctx.root);
  try {
    // Tools that change something need the user's go-ahead. The preview runs
    // first, so a call that can't succeed fails here instead of being approved.
    const gated = tool.needsApproval ? tool.needsApproval(parsed.data) : Boolean(tool.kind && tool.kind !== "read");
    if (gated) {
      if (!ctx.approve) return fail(`${call.name} needs the user's approval, and there's no one to ask.`, label);
      const preview = await tool.preview!(parsed.data, ctx);
      const scope = tool.scope?.(parsed.data) ?? { key: call.name, description: call.name };
      const network = tool.usesNetwork?.(parsed.data) ? { network: true } : {};
      const decision = await ctx.approve({ tool: call.name, label, preview, scope, ...network });
      if (decision === "no") {
        return {
          output: "The user declined this. Don't retry it: stop and wait for them to say how to proceed.",
          summary: "declined",
          declined: true,
          label,
        };
      }
    }
    return { ...(await tool.run(parsed.data, { ...ctx, callId: call.id })), label };
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message, label);
    return fail(`${call.name} failed: ${(err as Error).message}`, label);
  }
}
```

- [ ] **Step 5: Flag bash's network calls** — in `src/tools/bash.ts`, add after the `scope:` line:
```ts
  usesNetwork: ({ network }) => Boolean(network),
```

- [ ] **Step 6: Run the tests**

Run: `bun test tests/tools tests/write-tools && bun run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/tools/types.ts src/tools/index.ts src/tools/bash.ts tests/tools.test.ts
git commit -m "Tools: per-call approval, network flag, restricted tool lists"
```

---

### Task 4: Extra writable folders in the sandbox

> **Superseded during review:** a writable shared `.git` lets a sandboxed command plant hooks or config that git later runs outside the sandbox. The sandbox now takes `readOnly: string[]` instead (extra folders shown read-only, e.g. a worktree's `.git`; refused for `/`, the home folder or its parents), and Marv makes the worktree commit itself (Task 7).

A worktree's `.git` is a file pointing into the main repo's `.git/worktrees/<id>`, and commits write objects into the main `.git`. With only the worktree writable, `git commit` inside the sandbox would fail.

**Files:**
- Modify: `src/sandbox.ts`, `src/tools/bash.ts`
- Test: `tests/bash.test.ts`

- [ ] **Step 1: Write the failing test** (inside `describe("sandboxArgs", …)` in `tests/bash.test.ts`)

```ts
  test("extra writable folders (a worktree's shared .git) are mounted after the home is hidden", () => {
    const args = sandboxArgs({ ...base, network: false, writable: ["/home/me/proj/.git"] });
    expect(args.join(" ")).toContain("--bind /home/me/proj/.git /home/me/proj/.git");
    expect(args.lastIndexOf("/home/me/proj/.git")).toBeGreaterThan(args.indexOf("--tmpfs", args.indexOf("/tmp") + 1));
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/bash -t "extra writable"`
Expected: FAIL (no such bind).

- [ ] **Step 3: Implement**

In `src/sandbox.ts`, add to `SandboxOptions`:
```ts
  /** More writable folders besides root, e.g. a worktree's shared .git. */
  writable?: string[];
```
Change the signature and the line after the root bind:
```ts
export function sandboxArgs({ root, home, network, path, writable = [], exists = existsSync }: SandboxOptions): string[] {
```
```ts
  args.push("--bind", root, root);
  for (const dir of writable) args.push("--bind", dir, dir);
```

In `src/tools/bash.ts`, add `writable?: string[];` to `RunOptions`, take it in `runCommand`, and pass it on:
```ts
export async function runCommand({ command, root, sandbox, network, timeoutMs, signal, writable }: RunOptions): Promise<CommandResult> {
```
```ts
    ? ["bwrap", ...sandboxArgs({ root, home, network, path, writable }), "--", "bash", "-c", script]
```
and in the tool's `run`:
```ts
  async run({ command, network = false, timeout = DEFAULT_TIMEOUT_S }, { root, signal, sandbox = true, writable }) {
    const result = await runCommand({ command, root, sandbox: sandbox && sandboxAvailable(), network, timeoutMs: timeout * 1000, signal, writable });
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/bash`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.ts src/tools/bash.ts tests/bash.test.ts
git commit -m "Sandbox: extra writable folders (for a worktree's .git)"
```

---

### Task 5: Parallel tool calls in the agent loop

**Files:**
- Modify: `src/agent.ts`
- Test: `tests/agent.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside `describe("runAgent", …)` in `tests/agent.test.ts`)

```ts
  describe("parallel calls", () => {
    const sub = (id: string, ms: number): ToolCall => ({ id, name: "agent", arguments: JSON.stringify({ description: id, ms }) });
    const isParallel = (c: ToolCall) => c.name === "agent";

    /** A runTool that sleeps `ms` for agent calls and records how many run at once. */
    function tracked(declineId?: string) {
      const state = { active: 0, max: 0, started: [] as string[] };
      const runTool = async (c: ToolCall) => {
        state.started.push(c.id);
        state.active++;
        state.max = Math.max(state.max, state.active);
        const { ms = 0 } = JSON.parse(c.arguments) as { ms?: number };
        await Bun.sleep(ms);
        state.active--;
        return { output: `out ${c.id}`, summary: "ok", label: c.id, ...(c.id === declineId ? { declined: true } : {}) };
      };
      return { state, runTool };
    }

    test("consecutive parallel calls run at once; results go into history in call order", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 60), sub("b", 10)), say("Both done.")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const { state, runTool } = tracked();
      const events = await run(provider, history, { runTool, isParallel });

      expect(state.max).toBe(2);
      // b finished first…
      expect(events.filter((e) => e.type === "tool_end").map((e) => e.type === "tool_end" && e.call.id)).toEqual(["b", "a"]);
      // …but the history is in call order, so every request is deterministic (prompt cache).
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.callId)).toEqual(["a", "b"]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "end" });
    });

    test("at most 4 run at once", async () => {
      const calls = Array.from({ length: 6 }, (_, i) => sub(`s${i}`, 20));
      const provider = new ScriptedProvider([useTools(...calls), say("ok")]);
      const { state, runTool } = tracked();
      await run(provider, [{ role: "user", text: "go" }], { runTool, isParallel });
      expect(state.max).toBe(4);
      expect(state.started).toHaveLength(6);
    });

    test("a non-parallel call between them splits the group", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 20), call("r", "x.ts"), sub("b", 20)), say("ok")]);
      const { state, runTool } = tracked();
      await run(provider, [{ role: "user", text: "go" }], { runTool, isParallel });
      expect(state.max).toBe(1);
      expect(state.started).toEqual(["a", "r", "b"]);
    });

    test("an interrupt answers queued calls without running them", async () => {
      const controller = new AbortController();
      const provider = new ScriptedProvider([useTools(sub("a", 10), sub("b", 10), sub("c", 10))]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const events = await run(provider, history, {
        signal: controller.signal,
        isParallel,
        maxParallel: 1,
        runTool: async (c) => {
          controller.abort();
          return { output: `out ${c.id}`, summary: "ok", label: c.id };
        },
      });
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual([
        "out a",
        "Interrupted by the user before this tool ran.",
        "Interrupted by the user before this tool ran.",
      ]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    test("a no in a parallel group lets the running ones finish, then stops", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 5), sub("b", 30)), say("never")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const { runTool } = tracked("a");
      const events = await run(provider, history, { runTool, isParallel });
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual(["out a", "out b"]);
      expect(provider.requests).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: "done", reason: "declined" });
    });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/agent.test.ts`
Expected: FAIL (`max` is 1, tool_end order a, b; `isParallel`/`maxParallel` unknown to the type checker is fine at runtime).

- [ ] **Step 3: Implement in `src/agent.ts`**

Add to the header comment, after "…keeps hitting.":
```ts
//
// Tool calls run one at a time, except subagents: several `agent` calls in
// one reply run at the same time (at most MAX_PARALLEL), and their results are
// still appended in call order, so the history doesn't depend on which
// finished first.
```

Add the import of `ToolResult` (already there) and these constants/types after `DEFAULT_MAX_STEPS`:
```ts
export const MAX_PARALLEL = 4;

const NOT_RUN = {
  aborted: "Interrupted by the user before this tool ran.",
  declined: "Not run: the user declined an earlier action.",
};

type Result = ToolResult & { label: string };
type GroupEvent =
  | { type: "start"; index: number; call: ToolCall }
  | { type: "end"; index: number; call: ToolCall; result: Result }
  | { type: "skip"; index: number; result: Result };
```

Add to `Options`:
```ts
  /** Calls that may run at the same time as their neighbours (subagents). Default: none. */
  isParallel?: (call: ToolCall) => boolean;
  maxParallel?: number;
```

Update `labelOf` so an agent call is labeled like the agent tool's own `label` ("general-purpose · Read notes") while it runs:
```ts
    const agent = typeof args.description === "string" ? `${args.type ?? "general-purpose"} · ${args.description}` : undefined;
    return String(args.path ?? args.pattern ?? args.command ?? agent ?? call.arguments);
```

Add this function above `runAgent`:
```ts
/**
 * Runs a group of calls at the same time (at most `limit` at once) and reports
 * each start and end as it happens. Calls still queued after an interrupt or a
 * "no" are answered without running.
 */
async function* runGroup(
  group: ToolCall[],
  runTool: Options["runTool"],
  limit: number,
  signal: AbortSignal,
): AsyncGenerator<GroupEvent> {
  const ready: GroupEvent[] = [];
  let wake: (() => void) | null = null;
  const emit = (event: GroupEvent) => {
    ready.push(event);
    wake?.();
    wake = null;
  };
  let next = 0;
  let active = 0;
  let settled = 0;
  let declined = false;
  const startMore = () => {
    while (active < limit && next < group.length) {
      const index = next++;
      const call = group[index]!;
      if (signal.aborted || declined) {
        settled++;
        emit({ type: "skip", index, result: { output: declined ? NOT_RUN.declined : NOT_RUN.aborted, summary: "not run", label: call.name } });
        continue;
      }
      active++;
      emit({ type: "start", index, call });
      void runTool(call)
        .catch((err: Error): Result => ({ output: `${call.name} failed: ${err.message}`, summary: "error", isError: true, label: call.name }))
        .then((result) => {
          active--;
          settled++;
          declined ||= Boolean(result.declined);
          emit({ type: "end", index, call, result });
          startMore();
        });
    }
  };
  startMore();
  while (settled < group.length || ready.length > 0) {
    if (ready.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    yield* ready.splice(0);
  }
}
```

In `runAgent`, take the new options:
```ts
  maxSteps = DEFAULT_MAX_STEPS,
  isParallel = () => false,
  maxParallel = MAX_PARALLEL,
}: Options): AsyncGenerator<LoopEvent> {
```

Replace the block from `// Every call must get a result…` through `declined = Boolean(result.declined);\n    }` with:
```ts
    // Every call must get a result, even after an interrupt or a "no": a
    // request with an unanswered tool call is rejected by the API.
    let declined = false;
    for (let i = 0; i < calls.length; ) {
      // A run of consecutive parallel calls goes together; anything else, one at a time.
      let end = i + 1;
      if (isParallel(calls[i]!)) while (end < calls.length && isParallel(calls[end]!)) end++;
      const group = calls.slice(i, end);
      i = end;
      if (signal.aborted || declined) {
        for (const call of group) history.push({ role: "tool", callId: call.id, name: call.name, text: declined ? NOT_RUN.declined : NOT_RUN.aborted });
        continue;
      }
      const results: Result[] = [];
      for await (const event of runGroup(group, runTool, maxParallel, signal)) {
        if (event.type === "start") {
          yield { type: "tool_start", call: event.call, label: labelOf(event.call) };
        } else {
          results[event.index] = event.result;
          if (event.type === "end") yield { type: "tool_end", call: event.call, result: event.result };
        }
      }
      // In call order, whatever order they finished in (prompt cache).
      group.forEach((call, k) => history.push({ role: "tool", callId: call.id, name: call.name, text: results[k]!.output }));
      declined = results.some((r) => r.declined);
    }
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/agent.test.ts && bun run typecheck`
Expected: all PASS, including the existing interrupt, declined and prefix tests.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts tests/agent.test.ts
git commit -m "Agent loop: run consecutive subagent calls in parallel"
```

---

### Task 6: Prompts: the `# Agents` section and the subagent prompt

**Files:**
- Modify: `src/prompt.ts`
- Test: `tests/system-prompt.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/system-prompt.test.ts`; import `subagentPrompt` too)

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/system-prompt`
Expected: FAIL (`subagentPrompt` is not exported; no `# Agents`).

- [ ] **Step 3: Implement in `src/prompt.ts`**

Add `agents?: { name: string; description: string }[];` to `PromptInput` (doc comment: `/** Agent types the agent tool can start: names and descriptions only. */`), take `agents = []` in `systemPrompt`'s parameters, and replace the tail of `systemPrompt` (from `const skillList` to the `return`) with:
```ts
  const agentList = agents.length
    ? `\n\n# Agents\n\nThe agent tool hands a self-contained task to a subagent: a fresh agent that sees only the prompt you give it, works with its own tools, and returns a report. Use one for research across many files, implementing one well-specified task, or an independent review, and keep your own context for coordinating. Put everything it needs in the prompt. Several agent calls in one reply run in parallel; give parallel agents that change files isolation: "worktree" so they don't collide, then review and merge their branches with git. Types:\n\n${agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`
    : "";
  const remembered = memory ? `\n\n${memorySection(memory)}` : "";
  return base + remembered + skillsSection(skills) + agentList + projectSection(instructions);
}

function skillsSection(skills: { name: string; description: string }[]): string {
  return skills.length
    ? `\n\n# Skills\n\nSkills are detailed instructions for particular kinds of tasks. When a request matches one of these, load it with the skill tool before you start, then follow it:\n\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
    : "";
}

const projectSection = (instructions?: string) => (instructions ? `\n\n# Project instructions (from ${INSTRUCTIONS_FILE})\n\n${instructions}` : "");

interface SubagentPromptInput {
  cwd: string;
  tools: string[];
  /** The agent type's own instructions; empty for general-purpose. */
  body: string;
  instructions?: string;
  skills?: { name: string; description: string }[];
  /** Set when it works in its own git worktree. */
  worktree?: { branch: string; base: string };
  date?: Date;
}

/**
 * A subagent's system prompt: its type's instructions, then what it needs to
 * know about its situation. No memory: that's the main agent's.
 */
export function subagentPrompt({ cwd, tools, body, instructions, skills = [], worktree, date = new Date() }: SubagentPromptInput): string {
  const role = body || "You are a general-purpose coding agent.";
  const where = worktree
    ? `\n\nYou are working in your own git worktree, on branch ${worktree.branch} (started from ${worktree.base}). Other agents can't see your changes until your branch is merged. Files ignored by git, such as node_modules and build output, aren't here: install dependencies first if you need them (bash with network: true). You can't commit: the repository is read-only here (git status, diff and log work). When you finish, Marv commits everything you changed to your branch.`
    : "";
  const base = `${role}

You are a subagent of Marv, a coding agent in the user's terminal. Another agent gave you the task in the first message. Your final message is your report back to it: say what you did, what you found, and anything left undone, completely and concisely. The user doesn't see your steps, only that report.

Working directory: ${cwd}
Today's date: ${date.toISOString().slice(0, 10)}

Your tools: ${tools.join(", ")}. Look at the actual code before you change or judge it. Paths are relative to the working directory. Commands run in a sandbox: only the working directory is writable, and there's no network unless you set network: true.${where}`;
  return base + skillsSection(skills) + projectSection(instructions);
}
```
(Delete the old `skillList`/`project`/`remembered` lines this replaces; the `const remembered` line is re-declared above.)

- [ ] **Step 4: Run the tests**

Run: `bun test tests/system-prompt && bun run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts tests/system-prompt.test.ts
git commit -m "Prompts: list agent types; a system prompt for subagents"
```

---

### Task 7: Worktrees

**Files:**
- Create: `src/worktree.ts`
- Test: `tests/worktree.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/worktree.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError } from "../src/tools/types.ts";
import { branchName, createWorktree, finishWorktree, inspectRepo, NOT_A_REPO } from "../src/worktree.ts";

let repo: string;
let trees: string;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "marv-wt-repo-"));
  trees = await mkdtemp(join(tmpdir(), "marv-wt-trees-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(trees, { recursive: true, force: true });
});

describe("inspectRepo", () => {
  test("the base commit and how many uncommitted changes would be left behind", async () => {
    expect(inspectRepo(repo)).toEqual({ base: git(repo, "rev-parse", "--short", "HEAD"), dirty: 0 });
    await writeFile(join(repo, "b.txt"), "new\n");
    expect(inspectRepo(repo)!.dirty).toBe(1);
  });

  test("null outside a git repo", () => {
    expect(inspectRepo(trees)).toBeNull();
  });
});

test("branchName: marv/<slug>-<id>", () => {
  expect(branchName("Task 2: Parser errors!", "ab12")).toBe("marv/task-2-parser-errors-ab12");
  expect(branchName("!!!", "ab12")).toBe("marv/task-ab12");
  expect(branchName("x".repeat(80), "ab12")).toBe(`marv/${"x".repeat(40)}-ab12`);
  expect(branchName("Fix it")).toMatch(/^marv\/fix-it-[0-9a-f]{4}$/);
});

describe("createWorktree / finishWorktree", () => {
  test("a new branch in its own folder, sharing the repo's .git", () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Fix parser" });
    expect(wt.branch).toMatch(/^marv\/fix-parser-[0-9a-f]{4}$/);
    expect(wt.dir.startsWith(trees)).toBe(true);
    expect(existsSync(join(wt.dir, "a.txt"))).toBe(true);
    expect(git(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
    expect(wt.gitDir).toBe(join(repo, ".git"));
    expect(wt.adminDir).toStartWith(join(repo, ".git", "worktrees"));
    expect(wt.base).toBe(git(repo, "rev-parse", "--short", "HEAD"));
  });

  test("Marv's own git ignores a planted hook and redirected git pointers", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Sneaky" });
    const pwned = join(trees, "PWNED");
    // Plant what a subagent might, if it could write there. (In real use the sandbox shows .git read-only; this is the second layer.)
    await mkdir(join(wt.gitDir, "hooks"), { recursive: true });
    await writeFile(join(wt.gitDir, "hooks", "pre-commit"), `#!/bin/sh\ntouch ${pwned}\n`, { mode: 0o755 });
    // The worktree's .git file pointed at a fake repository whose config runs a program.
    const fake = join(trees, "fake.git");
    git(trees, "init", "-q", "--bare", fake);
    git(fake, "config", "core.fsmonitor", `touch ${pwned}`);
    await writeFile(join(wt.dir, ".git"), `gitdir: ${fake}\n`);
    await writeFile(join(wt.adminDir, "commondir"), `${fake}\n`);
    await writeFile(join(wt.dir, "b.txt"), "bee\n");

    finishWorktree(wt, { description: "Sneaky", interrupted: false });
    expect(existsSync(pwned)).toBe(false);
    expect(git(repo, "show", `${wt.branch}:b.txt`)).toBe("bee"); // committed to the real branch, not the fake repo
  });

  test("leftover changes are committed, the folder removed, the branch kept", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Add b" });
    await writeFile(join(wt.dir, "b.txt"), "bee\n");
    const line = finishWorktree(wt, { description: "Add b", interrupted: false });
    expect(line).toContain(`Branch ${wt.branch}: 1 commit on ${wt.base}`);
    expect(existsSync(wt.dir)).toBe(false);
    expect(git(repo, "show", `${wt.branch}:b.txt`)).toBe("bee");
    expect(git(repo, "log", "-1", "--format=%s", wt.branch)).toBe("marv: Add b");
    expect(existsSync(join(repo, "b.txt"))).toBe(false); // the main checkout is untouched
  });

  test("an interrupted subagent's work is committed and marked", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Half done" });
    await writeFile(join(wt.dir, "c.txt"), "c\n");
    finishWorktree(wt, { description: "Half done", interrupted: true });
    expect(git(repo, "log", "-1", "--format=%s", wt.branch)).toBe("marv: Half done (interrupted)");
  });

  test("no changes: the branch is deleted too", () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Nothing" });
    expect(finishWorktree(wt, { description: "Nothing", interrupted: false })).toBe(`No changes (branch ${wt.branch} removed).`);
    expect(git(repo, "branch", "--list", wt.branch)).toBe("");
  });

  test("outside a git repo: a ToolError the model can act on", () => {
    expect(() => createWorktree({ root: trees, baseDir: trees, description: "x" })).toThrow(new ToolError(NOT_A_REPO));
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/worktree`
Expected: FAIL, `Cannot find module '../src/worktree.ts'`.

- [ ] **Step 3: Write `src/worktree.ts`**

```ts
// Git worktrees for subagents: a second checkout of the same repository, on
// its own branch, so agents working in parallel don't edit the same files.
//
//   git worktree add -b marv/<task>-<id> ~/.marv/worktrees/<project>/<task>-<id> HEAD
//
// Inside the sandbox a subagent can change only its worktree's files: the
// repository's .git is visible read-only (git status, diff and log work), so
// it can't plant hooks or config that git would later run outside the
// sandbox. When it's done, Marv commits its changes to the branch, removes the
// folder and keeps the branch, which the parent agent reviews and merges.
import { mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ToolError } from "./tools/types.ts";

export interface Worktree {
  dir: string;
  branch: string;
  /** Short hash of the commit it started from. */
  base: string;
  /** The main checkout (the project root). */
  repo: string;
  /** The repository's shared .git folder (the sandbox shows it read-only). */
  gitDir: string;
  /** This worktree's own folder inside it (.git/worktrees/<id>): its HEAD and index. */
  adminDir: string;
}

export const NOT_A_REPO =
  'isolation: "worktree" needs a git repository with at least one commit. Start the agent without isolation instead.';

function git(cwd: string, args: string[], env?: Record<string, string>): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: env && { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const ok = result.exitCode === 0;
  return { ok, out: (ok ? result.stdout : result.stderr).toString().trim() };
}

/** Hooks and fsmonitor are how a repository makes git run a program; Marv's own git calls on worktrees turn both off. */
const NO_PROGRAMS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/**
 * Git on a worktree after a subagent used it, run by Marv outside the
 * sandbox. Every git path is pinned through the environment: the worktree's
 * `.git` file was within the subagent's reach and could point at a fake
 * repository with its own config.
 */
const worktreeGit = (wt: Worktree, ...args: string[]) =>
  git(wt.dir, [...NO_PROGRAMS, ...args], { GIT_DIR: wt.adminDir, GIT_COMMON_DIR: wt.gitDir, GIT_WORK_TREE: wt.dir });
const repoGit = (wt: Worktree, ...args: string[]) => git(wt.repo, [...NO_PROGRAMS, ...args]);

/** What a worktree would start from, and how many uncommitted changes it would leave behind. Null outside a repo. */
export function inspectRepo(root: string): { base: string; dirty: number } | null {
  const head = git(root, ["rev-parse", "--short", "HEAD"]);
  if (!head.ok) return null;
  const status = git(root, ["status", "--porcelain"]).out;
  return { base: head.out, dirty: status ? status.split("\n").length : 0 };
}

/** "Task 2: Parser errors" → "marv/task-2-parser-errors-ab12" */
export function branchName(description: string, id = crypto.randomUUID().slice(0, 4)): string {
  const slug =
    description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return `marv/${slug}-${id}`;
}

export function createWorktree({ root, baseDir, description }: { root: string; baseDir: string; description: string }): Worktree {
  const repo = inspectRepo(root);
  if (!repo) throw new ToolError(NOT_A_REPO);
  const branch = branchName(description);
  const dir = join(baseDir, branch.slice("marv/".length));
  mkdirSync(baseDir, { recursive: true });
  const added = git(root, ["worktree", "add", "-q", "-b", branch, dir, "HEAD"]);
  if (!added.ok) throw new ToolError(`Couldn't create a worktree: ${added.out}`);
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(dir, path));
  const gitDir = absolute(git(dir, ["rev-parse", "--git-common-dir"]).out);
  const adminDir = absolute(git(dir, ["rev-parse", "--git-dir"]).out);
  return { dir, branch, base: repo.base, repo: root, gitDir, adminDir };
}

/**
 * Commits the subagent's changes, removes the folder and keeps the branch (or
 * deletes it if nothing was committed). Returns the line the parent agent
 * reads. If the commit fails, the folder is kept and its path reported, so no
 * work is lost.
 */
export function finishWorktree(wt: Worktree, { description, interrupted }: { description: string; interrupted: boolean }): string {
  if (worktreeGit(wt, "status", "--porcelain").out) {
    worktreeGit(wt, "add", "-A");
    const committed = worktreeGit(wt, "commit", "-q", "-m", `marv: ${description}${interrupted ? " (interrupted)" : ""}`);
    if (!committed.ok) return `Branch ${wt.branch}: couldn't commit the changes (${committed.out}). They're still in ${wt.dir}.`;
  }
  const count = Number(repoGit(wt, "rev-list", "--count", `${wt.base}..${wt.branch}`).out) || 0;
  // Deleting the folder and pruning (rather than `git worktree remove`) never reads anything inside the worktree.
  rmSync(wt.dir, { recursive: true, force: true });
  repoGit(wt, "worktree", "prune");
  if (count === 0) {
    repoGit(wt, "branch", "-D", wt.branch);
    return `No changes (branch ${wt.branch} removed).`;
  }
  return `Branch ${wt.branch}: ${count} commit${count === 1 ? "" : "s"} on ${wt.base}. Review it with \`git diff ${wt.base}...${wt.branch}\`, then merge it.`;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/worktree`
Expected: all PASS. (If `wt.gitDir` differs from `join(repo, ".git")` only by a symlinked tmp path, compare with `realpathSync` on both sides.)

- [ ] **Step 5: Commit**

```bash
git add src/worktree.ts tests/worktree.test.ts
git commit -m "Worktrees: create, inspect, and finish (commit leftovers, keep the branch)"
```

---

### Task 8: The subagent runner and the `agent` tool

**Files:**
- Create: `src/subagent.ts`, `src/tools/agent.ts`
- Modify: `src/tools/index.ts` (register), `tests/fake-provider.ts` (`RoutedProvider`), `tests/tools.test.ts` and `tests/app.test.tsx` (tool-list expectations)
- Test: `tests/agent-tool.test.ts`

- [ ] **Step 1: Add `RoutedProvider` to `tests/fake-provider.ts`**

```ts
/**
 * Several scripted models behind one provider, for subagents running in
 * parallel (their requests interleave, so one script can't serve them all).
 * Each request goes to the route whose key appears in the conversation's
 * first user message: the parent's request, or a subagent's prompt.
 */
export class RoutedProvider implements Provider {
  readonly name = "routed";
  constructor(private routes: Record<string, Provider>) {}

  stream(history: ChatTurn[], options: StreamOptions = {}) {
    const first = history.find((turn) => turn.role === "user")?.text ?? "";
    const key = Object.keys(this.routes).find((k) => first.includes(k));
    if (!key) throw new Error(`No route for a conversation starting "${first.slice(0, 60)}"`);
    return this.routes[key]!.stream(history, options);
  }
}
```

- [ ] **Step 2: Write the failing tests**

`tests/agent-tool.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";
import { GENERAL_PURPOSE, type AgentType } from "../src/agents.ts";
import type { AgentEvent, ChatTurn, Provider, StreamOptions, ToolCall, Usage } from "../src/provider/types.ts";
import { sandboxAvailable } from "../src/sandbox.ts";
import { isParallelCall, runTool } from "../src/tools/index.ts";
import type { AgentHost, AgentProgress, ApprovalRequest, Decision, ToolContext } from "../src/tools/types.ts";
import { NOT_A_REPO } from "../src/worktree.ts";
import { RoutedProvider, ScriptedProvider } from "./fake-provider.ts";

let root: string;
let trees: string;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-agent-tool-"));
  trees = await mkdtemp(join(tmpdir(), "marv-agent-trees-"));
  await writeFile(join(root, "notes.txt"), "remember the milk\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(trees, { recursive: true, force: true });
});

const say = (text: string, usage?: Usage): AgentEvent[] => [
  { type: "text_delta", text },
  ...(usage ? [{ type: "usage" as const, usage }] : []),
  { type: "done", reason: "stop" },
];
const useTool = (id: string, name: string, args: unknown): AgentEvent[] => [
  { type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } },
  { type: "done", reason: "tool_calls" },
];
const agentCall = (args: Record<string, unknown>, id = "a1"): ToolCall => ({ id, name: "agent", arguments: JSON.stringify(args) });

function makeHost(provider: Provider, over: Partial<AgentHost> = {}) {
  const seen = { usage: [] as Usage[], progress: [] as AgentProgress[], models: [] as (string | undefined)[] };
  const host: AgentHost = {
    agents: [GENERAL_PURPOSE],
    providerFor: (model) => (seen.models.push(model), provider),
    cwd: "~/proj",
    worktreesDir: trees,
    onUsage: (u) => seen.usage.push(u),
    onProgress: (_id, p) => seen.progress.push(p),
    ...over,
  };
  return { host, seen };
}

function ctxWith(host: AgentHost, decide: (r: ApprovalRequest) => Decision = () => "yes") {
  const asked: ApprovalRequest[] = [];
  const ctx: ToolContext = { root, agentHost: host, approve: async (r) => (asked.push(r), decide(r)) };
  return { ctx, asked };
}

describe("the agent tool", () => {
  test("the subagent starts fresh, and only its last message comes back", async () => {
    const provider = new ScriptedProvider([say("Found 3 callers.", { promptTokens: 1000, completionTokens: 200 })]);
    const { host, seen } = makeHost(provider);
    const { ctx, asked } = ctxWith(host);
    const result = await runTool(agentCall({ description: "find callers", prompt: "Find callers of foo" }), ctx);

    expect(provider.requests[0]!.history).toEqual([{ role: "user", text: "Find callers of foo" }]);
    expect(result.output).toBe("Found 3 callers.");
    expect(result.summary).toBe('done · 0 tools · 1.2k tokens · "Found 3 callers."');
    expect(result.label).toBe("general-purpose · find callers");
    expect(asked).toHaveLength(0); // a shared-folder dispatch doesn't ask
    expect(seen.usage).toEqual([{ promptTokens: 1000, completionTokens: 200 }]);
  });

  test("it gets subagent tools only, and its type's instructions", async () => {
    const reviewer: AgentType = { ...GENERAL_PURPOSE, name: "reviewer", body: "You review code.", tools: ["read_file", "grep"], source: "project" };
    const provider = new ScriptedProvider([say("ok"), say("ok")]);
    const { host } = makeHost(provider, { agents: [GENERAL_PURPOSE, reviewer] });
    const { ctx } = ctxWith(host);
    await runTool(agentCall({ description: "x", prompt: "p" }), ctx);
    await runTool(agentCall({ type: "superpowers:reviewer", description: "x", prompt: "p" }), ctx);

    expect(provider.requests[0]!.options.tools!.map((t) => t.name)).toEqual(["read_file", "glob", "grep", "edit_file", "write_file", "bash"]);
    expect(provider.requests[1]!.options.tools!.map((t) => t.name)).toEqual(["read_file", "grep"]);
    expect(provider.requests[1]!.options.system).toStartWith("You review code.");
  });

  test("a tool it wasn't given is refused, even if the model names it", async () => {
    const provider = new ScriptedProvider([useTool("m1", "memory", { action: "add", text: "x" }), say("ok")]);
    const { host } = makeHost(provider);
    await runTool(agentCall({ description: "x", prompt: "p" }), ctxWith(host).ctx);
    expect(provider.requests[1]!.history.at(-1)).toMatchObject({ role: "tool", text: expect.stringContaining('Unknown tool "memory"') });
  });

  test("it works in the project, and reports progress", async () => {
    const provider = new ScriptedProvider([useTool("r1", "read_file", { path: "notes.txt" }), say("It says milk.")]);
    const { host, seen } = makeHost(provider);
    const result = await runTool(agentCall({ description: "read notes", prompt: "What's in notes.txt?" }), ctxWith(host).ctx);
    expect(result.summary).toStartWith("done · 1 tool ·");
    expect(seen.progress.map((p) => p.line)).toContain("shared folder · 1 tool · read_file notes.txt");
    expect(seen.progress.at(-1)!.steps).toEqual(["read_file notes.txt · 1 line"]);
  });

  test("an error returns what it had, marked as an error", async () => {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "Partial findings." }, { type: "error", message: "Rate limited" }]]);
    const { host } = makeHost(provider);
    const result = await runTool(agentCall({ description: "x", prompt: "p" }), ctxWith(host).ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Partial findings.");
    expect(result.output).toContain("Rate limited");
    expect(result.summary).toStartWith("stopped ·");
  });

  test("a type's model gets its own provider", async () => {
    const fast: AgentType = { ...GENERAL_PURPOSE, name: "fast", model: "small-model", source: "project" };
    const { host, seen } = makeHost(new ScriptedProvider([say("ok")]), { agents: [GENERAL_PURPOSE, fast] });
    await runTool(agentCall({ type: "fast", description: "x", prompt: "p" }), ctxWith(host).ctx);
    expect(seen.models).toEqual(["small-model"]);
  });

  test("unknown types and nesting are errors the model can read", async () => {
    const { host } = makeHost(new ScriptedProvider([]));
    expect((await runTool(agentCall({ type: "nope", description: "x", prompt: "p" }), ctxWith(host).ctx)).output).toContain('no agent type "nope". Available: general-purpose');
    expect((await runTool(agentCall({ description: "x", prompt: "p" }), { root })).output).toContain("Subagents can't start subagents");
  });

  test("a shared-folder subagent's changes are approved by the user, labeled with who asks", async () => {
    const provider = new ScriptedProvider([useTool("w1", "write_file", { path: "made.txt", content: "hi\n" }), say("Made it.")]);
    const { host } = makeHost(provider);
    const { ctx, asked } = ctxWith(host);
    await runTool(agentCall({ description: "make file", prompt: "p" }), ctx);
    expect(asked.map((r) => [r.tool, r.agent])).toEqual([["write_file", "general-purpose · make file"]]);
    expect(existsSync(join(root, "made.txt"))).toBe(true);
  });

  test("a no inside the subagent stops it and the parent", async () => {
    const provider = new ScriptedProvider([useTool("w1", "write_file", { path: "made.txt", content: "hi\n" }), say("never")]);
    const { host } = makeHost(provider);
    const result = await runTool(agentCall({ description: "x", prompt: "p" }), ctxWith(host, () => "no").ctx);
    expect(result.declined).toBe(true);
    expect(provider.requests).toHaveLength(1);
  });

  describe("in a worktree", () => {
    beforeEach(() => {
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "first");
    });

    test("approve once to start it; its edits land on its own branch", async () => {
      const provider = new ScriptedProvider([useTool("w1", "write_file", { path: "new.txt", content: "new\n" }), say("Added new.txt.")]);
      const { host } = makeHost(provider);
      const { ctx, asked } = ctxWith(host);
      const result = await runTool(agentCall({ description: "add file", prompt: "p", isolation: "worktree" }), ctx);

      // The dispatch is approved; inside the worktree, edits run without asking (when the sandbox works).
      expect(asked[0]!.tool).toBe("agent");
      expect(asked[0]!.scope.key).toBe("agent:worktree");
      expect(asked).toHaveLength(sandboxAvailable() ? 1 : 2);
      const branch = /Branch (marv\/add-file-[0-9a-f]{4}): 1 commit/.exec(result.output)?.[1];
      expect(branch).toBeDefined();
      expect(git(root, "show", `${branch}:new.txt`)).toBe("new");
      expect(existsSync(join(root, "new.txt"))).toBe(false);
      expect(provider.requests[0]!.options.system).toContain(`branch ${branch}`);
    });

    test("network commands still ask", async () => {
      const provider = new ScriptedProvider([useTool("b1", "bash", { command: "bun install", network: true }), say("never")]);
      const { host } = makeHost(provider);
      const { ctx, asked } = ctxWith(host, (r) => (r.tool === "agent" ? "yes" : "no"));
      const result = await runTool(agentCall({ description: "install", prompt: "p", isolation: "worktree" }), ctx);
      expect(asked.map((r) => [r.tool, r.network, r.agent])).toEqual([
        ["agent", undefined, undefined],
        ["bash", true, "general-purpose · install"],
      ]);
      expect(result.declined).toBe(true);
    });

    test("the approval warns about uncommitted changes", async () => {
      await writeFile(join(root, "dirty.txt"), "x\n");
      const { host } = makeHost(new ScriptedProvider([say("ok")]));
      const { ctx, asked } = ctxWith(host);
      await runTool(agentCall({ description: "x", prompt: "p", isolation: "worktree" }), ctx);
      expect(asked[0]!.preview.warning).toContain("1 uncommitted change in the project won't be in the worktree");
    });
  });

  test("outside a git repo, a worktree dispatch fails before asking", async () => {
    const { host } = makeHost(new ScriptedProvider([]));
    const { ctx, asked } = ctxWith(host);
    const result = await runTool(agentCall({ description: "x", prompt: "p", isolation: "worktree" }), ctx);
    expect(result.output).toBe(NOT_A_REPO);
    expect(asked).toHaveLength(0);
  });

  test("two subagents in one reply run at the same time", async () => {
    let active = 0;
    let max = 0;
    const slow = (text: string): Provider => ({
      name: "slow",
      async *stream(_h: ChatTurn[], _o?: StreamOptions) {
        active++;
        max = Math.max(max, active);
        await Bun.sleep(40);
        active--;
        yield { type: "text_delta", text } as AgentEvent;
        yield { type: "done" } as AgentEvent;
      },
    });
    const parent = new ScriptedProvider([
      [
        { type: "tool_call", call: agentCall({ description: "a", prompt: "alpha task" }, "a1") },
        { type: "tool_call", call: agentCall({ description: "b", prompt: "beta task" }, "a2") },
        { type: "done" },
      ],
      say("Both reported."),
    ]);
    const provider = new RoutedProvider({ "start two": parent, "alpha task": slow("A done"), "beta task": slow("B done") });
    const { host } = makeHost(provider);
    const history: ChatTurn[] = [{ role: "user", text: "start two" }];
    for await (const _ of runAgent({
      provider,
      history,
      system: "S",
      tools: [],
      runTool: (c) => runTool(c, { root, agentHost: host }),
      signal: new AbortController().signal,
      isParallel: isParallelCall,
    }));
    expect(max).toBe(2);
    expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual(["A done", "B done"]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `bun test tests/agent-tool`
Expected: FAIL (no `agent` tool: `Unknown tool "agent"`; `isParallelCall` not exported).

- [ ] **Step 4: Write `src/subagent.ts`**

```ts
// Running a subagent: the same agent loop (runAgent) started again, with a
// fresh conversation, its own system prompt and its own tools. Only its final
// message goes back to the agent that started it, so the files it read and the
// steps it took never fill up the parent's context.
//
// Note: this module and src/tools/index.ts import each other (the registry
// holds the agent tool; a subagent runs the registry's tools). That's fine
// because neither uses the other's exports until a function is called.
import { runAgent } from "./agent.ts";
import { findAgent, type AgentType } from "./agents.ts";
import { shortenHome } from "./paths.ts";
import { subagentPrompt } from "./prompt.ts";
import { sandboxAvailable } from "./sandbox.ts";
import { runTool, tools, toolSpecs } from "./tools/index.ts";
import { ToolError, type AgentHost, type Decision, type ToolContext, type ToolResult } from "./tools/types.ts";
import { tokens } from "./usage.ts";
import { createWorktree, finishWorktree, type Worktree } from "./worktree.ts";

/** Implementing a task takes more steps than answering a question. */
export const SUBAGENT_MAX_STEPS = 50;
/** Finished steps kept per subagent for ctrl+o: labels and summaries only. */
const MAX_STEPS_KEPT = 20;

export interface SubagentInput {
  type?: string;
  description: string;
  prompt: string;
  isolation?: "worktree";
}

const STOPPED: Record<string, string> = {
  aborted: "Interrupted by the user before it finished.",
  max_steps: `It hit its ${SUBAGENT_MAX_STEPS}-step limit before finishing.`,
  length: "Its last reply was cut off by the model's output limit.",
  error: "It stopped on an error:",
};

export function resolveType(host: AgentHost, name = "general-purpose"): AgentType {
  const type = findAgent(host.agents, name);
  if (!type) throw new ToolError(`There's no agent type "${name}". Available: ${host.agents.map((a) => a.name).join(", ")}.`);
  return type;
}

/**
 * How a subagent's changes get approved. In a worktree with the sandbox on,
 * they run without asking: the worktree is the boundary, and merging its
 * branch is the review. Network access still asks (a worktree limits what a
 * command changes, not what it sends out). Otherwise the user is asked, with
 * the request labeled by which subagent is asking.
 */
export function subagentApprove(approve: ToolContext["approve"], agent: string, auto: boolean): ToolContext["approve"] {
  if (!approve) return undefined;
  return (request) => (auto && !request.network ? Promise.resolve<Decision>("yes") : approve({ ...request, agent }));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function runSubagent(input: SubagentInput, ctx: ToolContext): Promise<ToolResult> {
  const host = ctx.agentHost;
  if (!host) throw new ToolError("Subagents can't start subagents.");
  const type = resolveType(host, input.type);
  const who = `${type.name} · ${input.description}`;

  let worktree: Worktree | undefined;
  if (input.isolation === "worktree") {
    if (!host.worktreesDir) throw new ToolError("Worktrees aren't available here. Start the agent without isolation.");
    worktree = createWorktree({ root: ctx.root, baseDir: host.worktreesDir, description: input.description });
  }

  const sandboxed = (ctx.sandbox ?? true) && sandboxAvailable();
  const hasSkills = (ctx.skills?.length ?? 0) > 0;
  const available = tools.filter((t) => type.tools.includes(t.name) && (t.name !== "skill" || hasSkills));
  const names = available.map((t) => t.name);
  const subCtx: ToolContext = {
    root: worktree?.dir ?? ctx.root,
    signal: ctx.signal,
    sandbox: ctx.sandbox,
    skills: ctx.skills,
    readOnly: worktree ? [worktree.gitDir] : undefined,
    approve: subagentApprove(ctx.approve, who, Boolean(worktree) && sandboxed),
  };
  const system = subagentPrompt({
    cwd: worktree ? shortenHome(worktree.dir) : host.cwd,
    tools: names,
    body: type.body,
    instructions: host.instructions,
    skills: hasSkills && names.includes("skill") ? ctx.skills : undefined,
    worktree: worktree && { branch: worktree.branch, base: worktree.base },
  });

  const where = worktree ? `worktree ${worktree.branch}` : "shared folder";
  let toolCount = 0;
  let used = 0;
  let current: string | undefined;
  const steps: string[] = [];
  const report = () => {
    if (ctx.callId) host.onProgress(ctx.callId, { line: `${where} · ${plural(toolCount, "tool")} · ${current ?? "thinking…"}`, steps: steps.slice(-MAX_STEPS_KEPT) });
  };

  let text = "";
  let reason = "error";
  let error: string | undefined;
  let declined = false;
  let branchLine: string | undefined;
  report();
  try {
    for await (const event of runAgent({
      provider: host.providerFor(type.model),
      history: [{ role: "user", text: input.prompt }],
      system,
      tools: toolSpecs.filter((spec) => names.includes(spec.name)),
      runTool: (call) => runTool(call, subCtx, available),
      signal: ctx.signal ?? new AbortController().signal,
      maxSteps: SUBAGENT_MAX_STEPS,
    })) {
      switch (event.type) {
        case "usage":
          used += event.usage.promptTokens + event.usage.completionTokens;
          host.onUsage(event.usage);
          break;
        case "assistant":
          text = event.text;
          break;
        case "tool_start":
          toolCount++;
          current = `${event.call.name} ${event.label}`;
          report();
          break;
        case "tool_end":
          steps.push(`${event.call.name} ${event.result.label} · ${event.result.isError ? "error" : event.result.summary}`);
          declined ||= Boolean(event.result.declined);
          current = undefined;
          report();
          break;
        case "error":
          error = event.message;
          break;
        case "done":
          reason = event.reason;
          break;
      }
    }
  } finally {
    if (worktree) branchLine = finishWorktree(worktree, { description: input.description, interrupted: reason !== "end" });
  }

  const stats = `${plural(toolCount, "tool")} · ${tokens(used)} tokens`;
  const stopped = reason === "end" || reason === "declined" ? "" : `[${STOPPED[reason] ?? `It stopped (${reason}).`}${error ? ` ${error}` : ""}]`;
  const output = [text.trim() || "(The subagent gave no report.)", stopped, branchLine].filter(Boolean).join("\n\n");
  if (declined) return { output, summary: `declined · ${stats}`, declined: true };
  if (stopped) return { output, summary: `stopped · ${stats}`, isError: true };
  const first = text.trim().split("\n")[0]!.slice(0, 80);
  return { output, summary: `done · ${stats}${first ? ` · "${first}"` : ""}` };
}
```

- [ ] **Step 5: Write `src/tools/agent.ts`**

```ts
import { z } from "zod";
import { sandboxAvailable } from "../sandbox.ts";
import { resolveType, runSubagent } from "../subagent.ts";
import { inspectRepo, NOT_A_REPO } from "../worktree.ts";
import { ToolError, type Tool } from "./types.ts";

const PREVIEW_CHARS = 400;

const input = z.object({
  type: z.string().optional().describe('The agent type, from the list in the system prompt. Default "general-purpose".'),
  description: z.string().min(1).describe('A short name for the task, 3-5 words, e.g. "Task 2: parser errors".'),
  prompt: z
    .string()
    .min(1)
    .describe("The complete task. The subagent sees nothing else: include the goal, the relevant files, constraints, and what to report back."),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe("Run it in its own git worktree on a new branch, so it can change files and build while other agents do too. You merge its branch afterwards."),
});

export const agent: Tool<typeof input> = {
  name: "agent",
  description:
    "Hand a self-contained task to a subagent: a separate agent with a fresh context and its own tools, which does the task and returns only its final report. " +
    "Several agent calls in one reply run in parallel. The available types are listed in the system prompt.",
  input,
  kind: "execute",
  parallel: true,
  // Starting one in a worktree is the user's one approval for it; a
  // shared-folder subagent asks before each change it makes instead.
  needsApproval: ({ isolation }) => isolation === "worktree",
  label: ({ type, description }) => `${type ?? "general-purpose"} · ${description}`,
  scope: () => ({ key: "agent:worktree", description: "subagents in their own worktrees" }),

  async preview({ type, description, prompt }, ctx) {
    if (!ctx.agentHost) throw new ToolError("Subagents can't start subagents.");
    const found = resolveType(ctx.agentHost, type);
    const repo = inspectRepo(ctx.root);
    if (!repo) throw new ToolError(NOT_A_REPO);
    const auto = (ctx.sandbox ?? true) && sandboxAvailable();
    return {
      title: `Start ${found.name} in its own worktree: ${description}`,
      text: prompt.length > PREVIEW_CHARS ? `${prompt.slice(0, PREVIEW_CHARS)}…` : prompt,
      note: `new branch from ${repo.base} · ${auto ? "edits and sandboxed commands run without asking inside its worktree" : "asks before each change (no sandbox)"}`,
      warning: repo.dirty
        ? `${repo.dirty} uncommitted change${repo.dirty === 1 ? "" : "s"} in the project won't be in the worktree (it starts from ${repo.base})`
        : undefined,
    };
  },

  // An arrow, not `run: runSubagent`: src/subagent.ts and the registry import
  // each other, and this defers the lookup until a call.
  run: (args, ctx) => runSubagent(args, ctx),
};
```

- [ ] **Step 6: Register it in `src/tools/index.ts`**

```ts
import { agent } from "./agent.ts";
```
```ts
export const tools: Tool[] = [readFile, glob, grep, skill, editFile, writeFile, bash, memory, agent] as Tool[];

/** Whether a call may run at the same time as its neighbours (subagents). */
export const isParallelCall = (call: ToolCall) => tools.some((t) => t.name === call.name && t.parallel);
```

- [ ] **Step 7: Update the tool-list expectations**

`tests/tools.test.ts` (in `describe("toolSpecs")`):
```ts
    expect(toolSpecs.map((t) => t.name)).toEqual(["read_file", "glob", "grep", "skill", "edit_file", "write_file", "bash", "memory", "agent"]);
```
`tests/app.test.tsx` (the test around line 253):
```ts
    expect(model.requests[0]!.options.tools!.map((t) => t.name)).toEqual(["read_file", "glob", "grep", "edit_file", "write_file", "bash", "memory", "agent"]);
```

- [ ] **Step 8: Run the tests**

Run: `bun test tests/agent-tool tests/tools tests/app && bun run typecheck`
Expected: all PASS. If "approve once…" fails, check that `subCtx.readOnly` holds the `.git` path (Task 4) and that the sandbox is available (`bwrap --version`).

- [ ] **Step 9: Commit**

```bash
git add src/subagent.ts src/tools/agent.ts src/tools/index.ts tests/fake-provider.ts tests/agent-tool.test.ts tests/tools.test.ts tests/app.test.tsx
git commit -m "The agent tool: subagents with their own context, tools and (optionally) worktree"
```

---

### Task 9: ctrl+letter shouldn't type a letter

`ink-text-input` ignores only ctrl+c among control keys; every other ctrl+letter is inserted as the plain letter (ctrl+a types "a" today). ctrl+o will toggle subagent details, so patch it to ignore all ctrl combinations.

**Files:**
- Create: `patches/ink-text-input@<version>.patch` (generated)
- Modify: `package.json` (`patchedDependencies`, written by bun)
- Test: `tests/prompt.test.tsx`

- [ ] **Step 1: Write the failing test** (append to `tests/prompt.test.tsx`; it already renders `PromptInput`. If its helper differs, render directly as below)

```tsx
test("ctrl+letter combinations don't type the letter", async () => {
  let value = "";
  const { stdin } = render(<PromptInput value={value} onChange={(v) => (value = v)} onSubmit={() => {}} history={[]} busy={false} commands={[]} />);
  stdin.write("\x0f"); // ctrl+o
  await Bun.sleep(20);
  stdin.write("\x01"); // ctrl+a
  await Bun.sleep(20);
  expect(value).toBe("");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/prompt -t "ctrl+letter"`
Expected: FAIL (value is "o" or "oa").

- [ ] **Step 3: Patch the package**

```bash
bun patch ink-text-input
```
In `node_modules/ink-text-input/build/index.js`, in the `useInput` handler, change
```js
            (key.ctrl && input === 'c') ||
```
to
```js
            key.ctrl ||
```
Then:
```bash
bun patch --commit node_modules/ink-text-input
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/prompt tests/app`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add patches/ package.json bun.lock tests/prompt.test.tsx
git commit -m "Prompt: ctrl+letter shortcuts no longer type the letter"
```

---

### Task 10: The approval queue and the Approval prompt

Today the App has one approval slot: a second request at the same time (parallel subagents) overwrites the first, whose promise then never resolves and that subagent hangs.

**Files:**
- Modify: `src/ui/Approval.tsx`, `src/app.tsx`
- Test: `tests/approval.test.tsx`

- [ ] **Step 1: Write the failing tests** (append inside `describe("Approval", …)` in `tests/approval.test.tsx`)

```tsx
  test("says which subagent is asking, and how many more are waiting", () => {
    const frame = render(<Approval request={{ ...EDIT, agent: "implementer · Task 2" }} waiting={2} onDecide={() => {}} />).lastFrame()!;
    expect(frame).toContain("[implementer · Task 2]");
    expect(frame).toContain("2 more waiting");
  });

  test("Esc cancels everything when the App passes onCancel", async () => {
    const onDecide = mock();
    const onCancel = mock();
    const { stdin } = render(<Approval request={EDIT} onDecide={onDecide} onCancel={onCancel} />);
    stdin.write(ESC);
    await tick();
    expect(onCancel).toHaveBeenCalled();
    expect(onDecide).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/approval`
Expected: FAIL (no label, no "more waiting", Esc calls onDecide).

- [ ] **Step 3: Update `src/ui/Approval.tsx`**

Change the signature and Esc handling:
```tsx
export function Approval({
  request,
  onDecide,
  onCancel,
  waiting = 0,
}: {
  request: ApprovalRequest;
  onDecide: (decision: Decision) => void;
  /** Esc: no to this and to everything waiting behind it. */
  onCancel?: () => void;
  /** Other requests queued behind this one (parallel subagents). */
  waiting?: number;
}) {
  const { preview, scope } = request;

  useInput((_input, key) => {
    if (key.escape) (onCancel ?? (() => onDecide("no")))();
  });
```
Replace `<Text bold>{preview.title}</Text>` with:
```tsx
      {request.agent && <Text color={theme.dim}>[{request.agent}]</Text>}
      <Text bold>{preview.title}</Text>
```
And after the `preview.warning` line add:
```tsx
      {waiting > 0 && <Text color={theme.dim}>{waiting} more waiting</Text>}
```

- [ ] **Step 4: Replace the single slot with a queue in `src/app.tsx`**

Replace the block from `// A tool waiting for the user's yes/no…` through the end of `decide` (lines ~165-184) with:
```tsx
  // Tools waiting for the user's yes/no, oldest first (parallel subagents can
  // ask at the same time). The first one is shown in place of the prompt.
  type Pending = { request: ApprovalRequest; resolve: (d: Decision) => void };
  const approvals = useRef<Pending[]>([]);
  const [approval, setApproval] = useState<{ head: Pending; waiting: number } | null>(null);
  const showApprovals = useCallback(() => {
    const [head] = approvals.current;
    setApproval(head ? { head, waiting: approvals.current.length - 1 } : null);
  }, []);
  // "Yes, don't ask again": scopes approved for the rest of this session.
  const alwaysAllowed = useRef(new Set<string>());

  const approve = useCallback(
    (request: ApprovalRequest): Promise<Decision> =>
      alwaysAllowed.current.has(request.scope.key)
        ? Promise.resolve("yes")
        : new Promise((resolve) => {
            approvals.current.push({ request, resolve });
            showApprovals();
          }),
    [showApprovals],
  );
  const decide = useCallback(
    (decision: Decision) => {
      const [head, ...rest] = approvals.current;
      if (!head) return;
      let remaining = rest;
      if (decision === "always") {
        const key = head.request.scope.key;
        alwaysAllowed.current.add(key);
        // Requests already waiting in the same scope are covered too.
        for (const pending of rest) if (pending.request.scope.key === key) pending.resolve("yes");
        remaining = rest.filter((pending) => pending.request.scope.key !== key);
      }
      approvals.current = remaining;
      showApprovals();
      head.resolve(decision);
    },
    [showApprovals],
  );
  /** Esc or ctrl+c at an approval: no to everything waiting. */
  const declineAll = useCallback(() => {
    const pending = approvals.current;
    approvals.current = [];
    showApprovals();
    for (const p of pending) p.resolve("no");
  }, [showApprovals]);
```

Update the users of the old names:
- Esc handler: `if (key.escape && abortRef.current && approvals.current.length === 0) abortRef.current.abort();`
- ctrl+c handler: replace `decide("no"); // a pending approval counts as declined` with `declineAll(); // pending approvals count as declined`
- Render: replace `<Approval request={approval.request} onDecide={decide} />` with `<Approval request={approval.head.request} waiting={approval.waiting} onDecide={decide} onCancel={declineAll} />`

- [ ] **Step 5: Run the tests**

Run: `bun test tests/approval tests/app && bun run typecheck`
Expected: all PASS (the existing App approval tests cover yes / no / always / ctrl+c on a single request).

- [ ] **Step 6: Commit**

```bash
git add src/ui/Approval.tsx src/app.tsx tests/approval.test.tsx
git commit -m "Approvals queue up (parallel subagents), Esc declines them all"
```

---

### Task 11: Wire subagents into the App

**Files:**
- Modify: `src/types.ts`, `src/ui/MessageView.tsx`, `src/ui/Transcript.tsx`, `src/ui/StatusBar.tsx`, `src/app.tsx`
- Test: `tests/app.test.tsx`

- [ ] **Step 1: Write the failing tests** (append to `tests/app.test.tsx`; add `RoutedProvider` to the fake-provider import and `GENERAL_PURPOSE` from `../src/agents.ts`)

```tsx
describe("subagents", () => {
  const ESC = "\x1b";
  const CTRL_O = "\x0f";
  const reply = (text: string) => [{ type: "text_delta", text }, { type: "done" }] as AgentEvent[];
  const calls = (...list: { id: string; name: string; args: unknown }[]) =>
    [...list.map(({ id, name, args }) => ({ type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } })), { type: "done" }] as AgentEvent[];

  function renderAgents(model: Provider) {
    return render(
      <App store={store} initialFile={LOCAL} env={{}} version="9.9.9" cwd="~/x" root={project} splashMs={0} makeProvider={() => model} loadModels={async () => []} agents={[GENERAL_PURPOSE]} />,
    );
  }

  test("a subagent is one entry that ends with its summary; ctrl+o shows its steps", async () => {
    const model = new ScriptedProvider([
      calls({ id: "a1", name: "agent", args: { description: "Read notes", prompt: "What's in notes.txt?" } }),
      calls({ id: "r1", name: "read_file", args: { path: "notes.txt" } }),
      reply("It says remember the milk."),
      reply("The subagent says: milk."),
    ]);
    const { lastFrame, stdin } = renderAgents(model);
    await type(stdin, "check the notes");
    await tick(300);
    expect(lastFrame()).toContain("agent general-purpose · Read notes");
    expect(lastFrame()).toContain('done · 1 tool');
    expect(lastFrame()).toContain("The subagent says: milk.");
    expect(model.requests[3]!.history.at(-1)).toMatchObject({ role: "tool", text: "It says remember the milk." });
    expect(lastFrame()).not.toContain("read_file notes.txt · 1 line");

    stdin.write(CTRL_O);
    await tick();
    expect(lastFrame()).toContain("read_file notes.txt · 1 line");
  });

  function twoWriters() {
    const parent = new ScriptedProvider([
      calls(
        { id: "a1", name: "agent", args: { description: "one", prompt: "write one.txt" } },
        { id: "a2", name: "agent", args: { description: "two", prompt: "write two.txt" } },
      ),
      reply("Both done."),
    ]);
    const writer = (path: string) => new ScriptedProvider([calls({ id: `w-${path}`, name: "write_file", args: { path, content: "x\n" } }), reply(`wrote ${path}`)]);
    return new RoutedProvider({ "make two": parent, "write one.txt": writer("one.txt"), "write two.txt": writer("two.txt") });
  }

  test("parallel subagents' approvals queue up, one at a time", async () => {
    const { lastFrame, stdin } = renderAgents(twoWriters());
    await type(stdin, "make two files");
    await tick(200);
    expect(lastFrame()).toContain("Do you want to proceed?");
    expect(lastFrame()).toContain("1 more waiting");
    expect(lastFrame()).toContain("2 agents running");

    stdin.write(ENTER);
    await tick(100);
    expect(lastFrame()).toContain("Do you want to proceed?"); // the second one
    expect(lastFrame()).not.toContain("more waiting");
    stdin.write(ENTER);
    await tick(300);
    expect(existsSync(join(project, "one.txt"))).toBe(true);
    expect(existsSync(join(project, "two.txt"))).toBe(true);
    expect(lastFrame()).toContain("Both done.");
  });

  test("Esc at a queued approval declines them all and stops", async () => {
    const { lastFrame, stdin } = renderAgents(twoWriters());
    await type(stdin, "make two files");
    await tick(200);
    stdin.write(ESC);
    await tick(300);
    expect(existsSync(join(project, "one.txt"))).toBe(false);
    expect(existsSync(join(project, "two.txt"))).toBe(false);
    expect(lastFrame()).toContain("Stopped. Tell Marv what to do instead.");
    expect(lastFrame()).not.toContain("Do you want to proceed?");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/app -t "subagents"`
Expected: FAIL (`agents` prop unknown; no agent host, so the tool says "Subagents can't start subagents").

- [ ] **Step 3: Transcript data and views**

`src/types.ts`, add to `ToolStatus`:
```ts
  /** A subagent's finished tool calls, shown with ctrl+o. */
  steps?: string[];
```

`src/ui/MessageView.tsx`: add a `showSteps?: boolean` prop (doc: `/** ctrl+o: show subagents' steps under their entry. */`), take it in the function's parameters, and replace the second `<Text …>` of the `"tool"` case plus close the box like this:
```tsx
          <Text color={failed ? theme.error : declined ? theme.warning : theme.dim} wrap="truncate-end">
            {"  ⎿ "}
            {tool.status === "running" ? (tool.summary ?? "running…") : tool.summary}
          </Text>
          {showSteps &&
            tool.steps?.map((step, i) => (
              <Text key={i} color={theme.dim} wrap="truncate-end">
                {"    · "}
                {step}
              </Text>
            ))}
        </Box>
```

`src/ui/Transcript.tsx`: add `showSteps?: boolean` to `Props`, take it, and render `<MessageView key={item.id} message={item.message} showSteps={showSteps} />`.

`src/ui/StatusBar.tsx`: add `/** Subagents running right now. */ agents?: number;` to `Props`, take `agents = 0`, and change the busy hint:
```tsx
      : busy
      ? `esc to interrupt${agents ? ` · ${agents} agent${agents === 1 ? "" : "s"} running` : ""}`
```

- [ ] **Step 4: App props, system prompt, host, progress, counts, ctrl+o** (`src/app.tsx`)

Imports:
```tsx
import { GENERAL_PURPOSE, type AgentType } from "./agents.ts";
import { isParallelCall, runTool, toolSpecsFor } from "./tools/index.ts";
import type { AgentHost, AgentProgress, ApprovalRequest, Decision } from "./tools/types.ts";
```

Props (after `memory`):
```tsx
  /** Agent types the agent tool can start, and files that couldn't be loaded. */
  agents?: AgentType[];
  agentProblems?: string[];
  /** Where subagents' worktrees go (~/.marv/worktrees/<project>); without it, no worktrees. */
  worktreesDir?: string;
```
and in the destructuring: `agents = [GENERAL_PURPOSE], agentProblems = [], worktreesDir,`.

System prompt:
```tsx
  const system = useMemo(
    () => systemPrompt({ cwd, tools: specs.map((t) => t.name), instructions, skills, memory: memories, agents }),
    [cwd, specs, instructions, skills, memories, agents],
  );
```

Running counts (replace the `toolRunning` state):
```tsx
  // Tools running right now (subagents run several at once), and how many of them are subagents.
  const [toolsRunning, setToolsRunning] = useState(0);
  const [agentsRunning, setAgentsRunning] = useState(0);
  // ctrl+o: show subagents' steps under their entries.
  const [showSteps, setShowSteps] = useState(false);
```

In `send`, replace `const toolLines = new Map<string, number>();` and the `flush` function with:
```tsx
      const toolLines = new Map<string, { line: number; label: string }>();
      // Subagents' progress, batched into the same flush as streamed text.
      const progress = new Map<string, AgentProgress>();
      const steps = new Map<string, string[]>();
      // Tokens accumulate in `reply`/`thought` and reach React in batches.
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        setStreaming(reply);
        setThinking(thought);
        for (const [callId, p] of progress) {
          const entry = toolLines.get(callId);
          if (entry) updateMessage(entry.line, { tool: { label: entry.label, status: "running", summary: p.line, steps: p.steps } });
        }
        progress.clear();
      };
      const scheduleFlush = () => {
        flushTimer ??= setTimeout(flush, STREAM_FLUSH_MS);
      };
      const agentHost: AgentHost = {
        agents,
        cwd,
        instructions,
        worktreesDir,
        providerFor: (model) => (model ? makeProvider({ ...configRef.current, model }) : provider),
        onUsage: countUsage,
        onProgress: (callId, p) => {
          progress.set(callId, p);
          steps.set(callId, p.steps);
          scheduleFlush();
        },
      };
```

The `runAgent` call:
```tsx
        for await (const event of runAgent({
          provider,
          history: conversation.current,
          system,
          tools: specs,
          runTool: (call) =>
            runTool(call, { root, signal: controller.signal, approve, sandbox: config.sandbox, skills, memory: memory?.paths, agentHost }),
          signal: controller.signal,
          isParallel: isParallelCall,
        })) {
```

The `tool_start` and `tool_end` cases:
```tsx
            case "tool_start":
              flush();
              noteThought();
              setToolsRunning((n) => n + 1);
              if (event.call.name === "agent") setAgentsRunning((n) => n + 1);
              toolLines.set(event.call.id, {
                label: event.label,
                line: addMessage({ role: "tool", text: event.call.name, tool: { label: event.label, status: "running" } }),
              });
              break;
            case "tool_end": {
              const { result } = event;
              const entry = toolLines.get(event.call.id);
              progress.delete(event.call.id); // a late progress flush mustn't turn it back to "running"
              // A plain failure shows its message; a subagent's error shows its own summary.
              const summary = result.isError && result.summary === "error" ? result.output.split("\n")[0] : result.summary;
              const status = result.declined ? "declined" : result.isError ? "error" : "done";
              if (entry) updateMessage(entry.line, { tool: { label: result.label, status, summary, steps: steps.get(event.call.id) } });
              setToolsRunning((n) => Math.max(0, n - 1));
              if (event.call.name === "agent") setAgentsRunning((n) => Math.max(0, n - 1));
              stepStarted = Date.now();
              break;
            }
```

In the `finally` block replace `setToolRunning(false);` with:
```tsx
        setToolsRunning(0);
        setAgentsRunning(0);
```

Add to `send`'s dependency list: `agents, cwd, instructions, worktreesDir, makeProvider`.

ThinkingView condition: `!toolRunning && <ThinkingView …/>` → `toolsRunning === 0 && <ThinkingView …/>`.

Pass the new props in the render:
```tsx
        <Transcript
          …
          showSteps={showSteps}
        />
```
and `agents={agentsRunning}` on both `<StatusBar … />` elements.

ctrl+o (next to the Esc handler):
```tsx
  // ctrl+o: show or hide what subagents did, under their entries.
  useInput(
    (char, key) => {
      if (key.ctrl && char === "o") setShowSteps((s) => !s);
    },
    { isActive: phase === "main" && setupMode === null },
  );
```

Agent files that couldn't be loaded (next to the skills notice):
```tsx
  useEffect(() => {
    if (agentProblems.length === 0) return;
    const count = agentProblems.length;
    addMessage({ role: "system", isError: true, text: `${count} agent file${count === 1 ? "" : "s"} couldn't be loaded (see /agents):\n${agentProblems.join("\n")}` });
  }, [agentProblems, addMessage]);
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/app tests/messageview && bun run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/ui/MessageView.tsx src/ui/Transcript.tsx src/ui/StatusBar.tsx src/app.tsx tests/app.test.tsx
git commit -m "App: subagents as live entries, ctrl+o for their steps, N agents running"
```

---

### Task 12: `/agents`, loading at startup, help

**Files:**
- Modify: `src/commands/index.ts`, `src/cli.tsx`, `src/app.tsx` (command context)
- Test: `tests/commands.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/commands.test.ts`, reusing its `run` and `ctx` helpers; import `GENERAL_PURPOSE` from `../src/agents.ts`)

```ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/commands -t "/agents"`
Expected: FAIL ("Unknown command: /agents").

- [ ] **Step 3: Implement**

`src/commands/index.ts`: import `type AgentType` from `../agents.ts` and `SUBAGENT_TOOLS`; add to `CommandContext`:
```ts
  agents?: AgentType[];
  /** Agent files that couldn't be loaded, and why. */
  agentProblems?: string[];
```
Add a command after `skills`:
```ts
  {
    name: "agents",
    description: "List the subagent types Marv can start",
    run: (_args, { agents = [], agentProblems = [] }) => ({ type: "print", text: agentsText(agents, agentProblems), markdown: true }),
  },
```
and the formatter at the end of the file:
```ts
/** Markdown, like /skills. Descriptions are cut at their first line (Claude Code ones carry long examples). */
function agentsText(agents: AgentType[], problems: string[]): string {
  const parts = [
    "**Agents**: Marv can hand a task to one of these. Add your own as `.marv/agents/<name>.md` (project) or `~/.marv/agents/<name>.md`.",
    agents
      .map((a) => {
        const details = [a.tools.length === SUBAGENT_TOOLS.length ? "" : `tools: ${a.tools.join(", ")}`, a.model ? `model: ${a.model}` : ""].filter(Boolean).join(" · ");
        return `- \`${a.name}\` *(${a.source})*: ${a.description.split("\n")[0]}${details ? `\n  ${details}` : ""}`;
      })
      .join("\n"),
  ];
  if (problems.length) parts.push("**Couldn't load:**", problems.map((p) => `- ${p}`).join("\n"));
  return parts.join("\n\n");
}
```
In `helpText()`, add a shortcut line: `"  ctrl+o    show what subagents did"`.

`src/app.tsx`, in `handleSubmit`'s `runCommand(text, { … })`, add `agents, agentProblems,`.

`src/cli.tsx`:
```tsx
import { loadAgents } from "./agents.ts";
import { projectKey, shortenHome } from "./paths.ts";
```
after `loadSkills`:
```tsx
const { agents, problems: agentProblems } = await loadAgents({ root, home: homedir() });
```
and on `<App … />`:
```tsx
    agents={agents}
    agentProblems={agentProblems}
    worktreesDir={join(defaultConfigDir(process.env), "worktrees", projectKey(root))}
```
In `HELP` under Config add:
```
  ~/.marv/agents/       your subagent types (a project's go in .marv/agents/)
  ~/.marv/worktrees/    subagents' worktrees while they run
```

- [ ] **Step 4: Run the tests**

Run: `bun test && bun run typecheck`
Expected: everything PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/index.ts src/cli.tsx src/app.tsx tests/commands.test.ts
git commit -m "/agents, and agent types loaded at startup"
```

---

### Task 13: Render budget with parallel subagents

**Files:**
- Test: `tests/render-performance.test.tsx`

- [ ] **Step 1: Write the test** (append; add `ScriptedProvider`, `RoutedProvider` from `./fake-provider.ts`, `writeFile` from `node:fs/promises`, `GENERAL_PURPOSE` from `../src/agents.ts`)

```tsx
test("4 subagents reporting progress still reach React in batches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marv-agents-perf-"));
  await writeFile(join(dir, "f.txt"), "x\n");
  const STEPS = 40;
  const busy = (n: number) =>
    new ScriptedProvider([
      ...Array.from({ length: STEPS }, (_, i) => [
        { type: "tool_call", call: { id: `r${n}-${i}`, name: "read_file", arguments: '{"path":"f.txt"}' } },
        { type: "done" },
      ] as AgentEvent[]),
      [{ type: "text_delta", text: `agent ${n} done` }, { type: "done" }] as AgentEvent[],
    ]);
  const parent = new ScriptedProvider([
    [
      ...[0, 1, 2, 3].map((n) => ({ type: "tool_call", call: { id: `a${n}`, name: "agent", arguments: JSON.stringify({ description: `job ${n}`, prompt: `job number ${n}` }) } })),
      { type: "done" },
    ] as AgentEvent[],
    [{ type: "text_delta", text: "all four finished" }, { type: "done" }] as AgentEvent[],
  ]);
  const model = new RoutedProvider({ "go now": parent, "job number 0": busy(0), "job number 1": busy(1), "job number 2": busy(2), "job number 3": busy(3) });
  let renders = 0;
  const { stdin, lastFrame, unmount } = renderForTest(
    <Profiler id="app" onRender={() => renders++}>
      <App store={new ConfigStore(dir)} initialFile={{ provider: "ollama", model: "m" }} env={{}} version="0" cwd="~" root={dir} splashMs={0} makeProvider={() => model} loadModels={async () => []} agents={[GENERAL_PURPOSE]} />
    </Profiler>,
  );
  await Bun.sleep(50);
  stdin.write("go now");
  await Bun.sleep(20);
  renders = 0;
  stdin.write("\r");
  while (!lastFrame()!.includes("all four finished")) await Bun.sleep(10);
  unmount();
  await rm(dir, { recursive: true, force: true });
  // 4 × 40 tool calls = 320 progress reports. Unbatched, that's 320+ renders.
  expect(renders).toBeLessThan((4 * STEPS * 2) / 3);
}, 30000);
```

- [ ] **Step 2: Run it**

Run: `bun test tests/render-performance -t "4 subagents"`
Expected: PASS (progress goes through `scheduleFlush`). If it fails, check that `onProgress` calls `scheduleFlush()` and not `updateMessage` directly.

- [ ] **Step 3: Commit**

```bash
git add tests/render-performance.test.tsx
git commit -m "Render-budget test for parallel subagents"
```

---

### Task 14: A worktree subagent can build and commit inside the real sandbox

This settles the spec's open point: can a sandboxed command in a worktree run `bun install && bun test` (`~/.bun` is read-only in the sandbox) and read git, while the repository itself stays unchangeable?

**Files:**
- Test: `tests/worktree-sandbox.test.ts`
- Possibly modify: `src/sandbox.ts` (Step 4)

- [ ] **Step 1: Write the test**

`tests/worktree-sandbox.test.ts`:
```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxAvailable } from "../src/sandbox.ts";
import { runCommand } from "../src/tools/bash.ts";
import { createWorktree, finishWorktree, type Worktree } from "../src/worktree.ts";

// The real sandbox, so only where bubblewrap works.
const sandboxed = sandboxAvailable() ? test : test.skip;
// Installing a real package needs the network: opt in with MARV_NETWORK_TESTS=1.
const online = sandboxAvailable() && process.env.MARV_NETWORK_TESTS === "1" ? test : test.skip;

let repo: string;
let trees: string;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "marv-wts-repo-"));
  trees = await mkdtemp(join(tmpdir(), "marv-wts-trees-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "demo", private: true }));
  await writeFile(join(repo, "sum.test.ts"), 'import { expect, test } from "bun:test";\ntest("sum", () => expect(1 + 1).toBe(2));\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(trees, { recursive: true, force: true });
});

// How a worktree subagent's bash runs: the worktree writable, the shared .git read-only.
const inWorktree = (wt: Worktree, command: string, network = false) =>
  runCommand({ command, root: wt.dir, sandbox: true, network, timeoutMs: 120_000, readOnly: [wt.gitDir] });

sandboxed("builds, tests and reads git inside the sandbox; Marv commits afterwards", async () => {
  const wt = createWorktree({ root: repo, baseDir: trees, description: "sandbox check" });
  const result = await inWorktree(wt, "bun install && bun test && echo hi > hi.txt && git status --porcelain && git log --oneline -1");
  expect(result.output).toContain("1 pass");
  expect(result.output).toContain("?? hi.txt");
  expect(result.exitCode).toBe(0);
  expect(finishWorktree(wt, { description: "sandbox check", interrupted: false })).toContain("1 commit");
  expect(git(repo, "show", `${wt.branch}:hi.txt`)).toBe("hi");
}, 130_000);

sandboxed("inside the sandbox, the repository can't be changed", async () => {
  const wt = createWorktree({ root: repo, baseDir: trees, description: "escape check" });
  for (const command of [
    "touch x && git add x", // the index lives in .git
    `echo 'touch /tmp/x' > ${join(wt.gitDir, "hooks", "pre-commit")}`,
    "git config core.fsmonitor 'touch /tmp/x'",
    `echo /elsewhere > ${join(wt.adminDir, "commondir")}`,
    "git branch -f main HEAD~0",
  ]) {
    expect((await inWorktree(wt, command)).exitCode).not.toBe(0);
  }
  finishWorktree(wt, { description: "escape check", interrupted: false });
}, 130_000);

online("installs a real dependency inside the sandbox", async () => {
  const wt = createWorktree({ root: repo, baseDir: trees, description: "deps check" });
  await writeFile(join(wt.dir, "package.json"), JSON.stringify({ name: "demo", private: true, dependencies: { "is-number": "7.0.0" } }));
  const result = await inWorktree(wt, "bun install && bun -e 'console.log(require(\\"is-number\\")(5))'", true);
  expect(result.output).toContain("true");
  expect(result.exitCode).toBe(0);
  finishWorktree(wt, { description: "deps check", interrupted: false });
}, 130_000);
```

- [ ] **Step 2: Run it**

Run: `bun test tests/worktree-sandbox && MARV_NETWORK_TESTS=1 bun test tests/worktree-sandbox`
Expected: PASS, or a failure whose output names `~/.bun/install/cache` (read-only file system).

- [ ] **Step 3: If both pass, skip Step 4 and commit**

- [ ] **Step 4 (only if the cache was the problem): mount the package cache writable when the network is on**

In `src/sandbox.ts`, after the `for (const dir of writable)` line:
```ts
  // Installing packages needs the network and a writable download cache.
  // (Only the cache, not the toolchain: the bun binary itself stays read-only.)
  if (network) {
    const cache = join(home, ".bun", "install", "cache");
    if (exists(cache)) args.push("--bind", cache, cache);
  }
```
Add to `tests/bash.test.ts` (inside `describe("sandboxArgs")`):
```ts
  test("with the network on, bun's download cache is writable", () => {
    const exists = (p: string) => p.endsWith(".bun") || p.endsWith(".bun/install/cache");
    expect(sandboxArgs({ ...base, exists, network: true }).join(" ")).toContain("--bind /home/me/.bun/install/cache /home/me/.bun/install/cache");
    expect(sandboxArgs({ ...base, exists, network: false }).join(" ")).not.toContain("--bind /home/me/.bun/install/cache");
  });
```
Re-run Step 2's commands and `bun test tests/bash`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/worktree-sandbox.test.ts src/sandbox.ts tests/bash.test.ts
git commit -m "Worktree subagents can build inside the sandbox; the repository stays read-only"
```

---

### Task 15: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `~/.claude/plans/im-planning-on-making-staged-eclipse.md` (roadmap row)

- [ ] **Step 1: `CLAUDE.md`**

Add an architecture bullet after **Memory**:
```md
- **Subagents (`src/agents.ts`, `src/subagent.ts`, `src/tools/agent.ts`, `src/worktree.ts`)**: the `agent` tool runs `runAgent()` again with a fresh history, the type's system prompt (`subagentPrompt`) and its tools; only its last message returns to the parent. Types are `.marv/agents/<name>.md` / `~/.marv/agents/<name>.md` (frontmatter `name`, `description`, optional `tools` — Claude Code names are mapped — and `model`), plus the built-in `general-purpose`; `findAgent` also tries a name without its `plugin:` prefix. Subagents never get `agent` or `memory`, and `runTool(call, ctx, available)` refuses tools they weren't given. Consecutive `agent` calls in one reply run in parallel (`MAX_PARALLEL` = 4; results appended in call order for the cache). `isolation: "worktree"` creates `~/.marv/worktrees/<project>/<slug>-<id>` on branch `marv/<slug>-<id>`; the dispatch is approved once (scope `agent:worktree`), then its changes are auto-approved while the sandbox is on, except `network: true`; its sandbox shows the repo's `.git` read-only (status/diff/log work; it can't commit, plant hooks or change config, which git would run outside the sandbox). When it ends, Marv commits its changes (every git path pinned via `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE`, hooks and fsmonitor off), deletes the folder, prunes, and keeps the branch (deleted if empty); the parent merges with git. Approvals are a FIFO queue in the App (`1 more waiting`; Esc/ctrl+c decline all); requests carry `agent` (who asks). Progress reaches the transcript through `AgentHost.onProgress`, batched with streamed text; ctrl+o shows each subagent's last 20 steps (`ink-text-input` is patched so ctrl+letter doesn't type).
```
Add `agent` to the list of `CommandAction`s only if one was added (none was: `/agents` is a `print`).

- [ ] **Step 2: `README.md`**

Under `## Features`, add a bullet: `Subagents: hand a task to a fresh agent (optionally in its own git worktree, several in parallel); agent types are Markdown files, compatible with Claude Code's.` Under `### Commands` add `/agents`; under `### Keys` add `ctrl+o — show what subagents did`; under `## Safety model` add: `A subagent in its own worktree is approved once when it starts; inside its worktree its edits and sandboxed commands then run without asking (network commands still ask, and with the sandbox off everything asks). Its work comes back as a branch you (or Marv, with approval) merge.` Under `## Files and settings` add `~/.marv/agents/` and `~/.marv/worktrees/`. Add a short `## Agents` section after `## Skills` showing the file format from the spec's section 1.

- [ ] **Step 3: Roadmap** — append a row to the table in `~/.claude/plans/im-planning-on-making-staged-eclipse.md`:
```md
| 9 | Subagents: the `agent` tool, agent types as files (Claude Code compatible), parallel runs, git worktree isolation with one approval per dispatch, approval queue, /agents, ctrl+o ✓ | hand tasks off, several at once |
```

- [ ] **Step 4: Run everything once more**

Run: `bun test && bun run typecheck`
Expected: everything PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Docs: subagents"
```

---

### Manual check (after all tasks)

1. `git clone https://github.com/obra/superpowers /tmp/sp && cp -r /tmp/sp/skills/* ~/.marv/skills/ && mkdir -p ~/.marv/agents && cp /tmp/sp/agents/code-reviewer.md ~/.marv/agents/`
2. In a scratch git repo: `marv`, then `/agents` (shows `code-reviewer`), then ask for something that dispatches two worktree subagents in parallel. Approve once (or "don't ask again"); watch two live lines; ctrl+o; check the branches with `git branch` and let Marv merge them.
3. Run `/subagent-driven-development` on a two-task plan and watch the implementer → spec reviewer → code-reviewer loop.
