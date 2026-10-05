# Marv SDK: the headless Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move everything that runs a turn out of `App.send()` into a UI-free `MarvSession` (`src/session.ts`), make the TUI a client of it, and publish it as `createSession()` from the package entry `marv/sdk`.

**Architecture:** `MarvSession` owns the conversation, provider(s), "always" scopes, MCP wait, auto-compaction, the subagent `AgentHost`, trajectory recording and saving. `send()` returns an async iterator of `SessionEvent`s; an internal `EventQueue` merges the main loop's events with subagent callbacks. `App` keeps only UI state and builds its session from its existing props (so the 640 existing tests are unchanged and prove the refactor). `src/sdk.ts` adds `createSession()` (reads nothing from disk unless `sources` says so) and the public exports. Spec: `docs/superpowers/specs/2026-10-05-sdk-session-design.md`.

**Tech Stack:** Bun ≥ 1.3, TypeScript, zod, React/Ink (TUI only), `bun:test`, `ink-testing-library`.

**Conventions (read CLAUDE.md first):** imports use explicit `.ts`/`.tsx` extensions and `import type` for types; tests never hit the network; `bun test <path substring>` runs one file; `bun run typecheck` must stay clean. The project owner is learning how agents work: commit messages and comments explain *why*. Work in the worktree `~/.config/superpowers/worktrees/Marv-agent/sdk-session` (branch `sdk-session`); don't touch the main checkout, another session works there.

---

## File map

| File | Responsibility |
|---|---|
| `src/sessions.ts` | saved-file type renamed `Session` → `SavedSession` |
| `src/tools/index.ts` | `specOf(tool)`; with no approver, yolo-safe calls still run |
| `src/agent.ts` | `agentArgs` moves here from `app.tsx` (the session and the App both use it) |
| `src/event-queue.ts` (new) | `EventQueue<T>`: push/close async queue, one reader |
| `src/skills.ts`, `src/agents.ts` | `root` and `home` each optional (load only the sources asked for) |
| `src/mcp/config.ts` | `loadMcpConfig({ include })`; `parseMcpServers()` for servers given in code |
| `src/sources.ts` (new) | `loadSources({ root, sources, configDir })` |
| `src/provider/factory.ts` (new) | `ProviderFactory`, `ProviderOption`, `configFactory`, `providerFactory`, `isFactory` |
| `src/session.ts` (new) | `MarvSession`, `SessionEvent`, `CompactResult`, `Resumed`, `SessionInit` |
| `src/app.tsx` | uses a `MarvSession`; keeps transcript, flush, approval queue UI, views |
| `src/sdk.ts` (new) | `createSession()`, `SessionOptions`, public exports |
| `package.json`, `tsconfig.json` | `exports`, `engines`, `files`; include `examples` |
| `examples/sdk.ts` (new) | runnable example |
| `tests/event-queue.test.ts`, `tests/no-approver.test.ts`, `tests/sources.test.ts`, `tests/provider-factory.test.ts`, `tests/session.test.ts`, `tests/sdk.test.ts` (new) | tests |
| `tests/sessions.test.ts` | the rename |
| `README.md`, `CLAUDE.md`, the spec | docs |

---

### Task 1: Record what planning changed in the spec

Planning against the code turned up a few things the spec should say differently. Record them before the code, so spec and code agree.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-05-sdk-session-design.md` (append a section)

- [ ] **Step 1: Append this section to the end of the spec**

```markdown
## Amendments from planning

Found while writing the implementation plan; they replace what's above where they differ.

- **The client supplies the transcript, not an opaque snapshot.** `SessionOptions.transcript?: () => Message[]`
  (the TUI passes its transcript). Without it the session saves its own: the user's messages and the replies.
  The saved file keeps its `transcript` field, so existing files, the picker's titles and `marv -r` work
  unchanged. `resume()` returns `Resumed { id, updatedAt, model, transcript, totals }`.
- **One compaction event:** `{ type: "compaction"; result: CompactResult }` replaces `compacted` and
  `compact_failed`. `CompactResult` is `{ compacted: true; summary; tokensBefore? }` or
  `{ compacted: false; reason: "empty" | "stopped" | "failed"; error }`; `compact()` returns the same type.
- **`clear()` returns a `Promise<void>`** (it reloads memory for the new system prompt); it throws at once
  during a turn. The next turn waits for the reload.
- **`configure()` never throws.** What a turn runs with (provider, sandbox, yolo, logging) is read when the turn
  starts, so a change during a turn applies from the next one. It also takes `trajectories?: boolean`.
- **`rate()` returns `"rated" | "off" | "nothing"`** so the TUI can say why nothing was rated.
- **Also on `Session`:** `busy`, `providerName`, `contextLength`, `modelInfo`, `memory`, `problems` (config files
  that couldn't be read), `save()` and `flush()` (the TUI saves between turns too, and flushes on exit).
- **`createSession()` lives in `src/sdk.ts`;** `src/session.ts` holds the class. Providers are made by a
  `ProviderFactory` (`src/provider/factory.ts`): the TUI builds one from its `Config`, the SDK from
  `ProviderOption`. `SessionOptions` gains `configDir` (default `~/.marv` or `$MARV_CONFIG_DIR`).
- **`"user"` is everything under `~/.marv`**, project memory included (it lives in
  `~/.marv/memory/projects/`, never in the repository). `"project"` is what's in the repository.
- **`runTool` checks for an approver after yolo:** with no approver, a call yolo vouches for still runs; the
  "no one to ask" error is for the rest. (It used to refuse every gated call when there was no approver.)
- **`src/cli.tsx` keeps loading what it loads today** and passes it to `App` as props; it doesn't use
  `loadSources`, which exists for `createSession()`.
- **Events are delivered through a queue:** the loop no longer waits for the consumer to handle `tool_start`
  before running the tool. Order is unchanged (a subagent's events always come after its `tool_start`), and a
  consumer that stops reading interrupts the turn.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-05-sdk-session-design.md
git commit -m "Spec: what planning changed for the SDK session

The client hands over its transcript instead of an opaque snapshot, so saved
files keep their shape; one compaction event; configure() applies from the
next turn instead of throwing; createSession() lives in sdk.ts."
```

---

### Task 2: Rename the saved-file `Session` to `SavedSession`

The public API needs the name `Session`. Purely mechanical.

**Files:**
- Modify: `src/sessions.ts`, `src/app.tsx`, `tests/sessions.test.ts`

- [ ] **Step 1: Rename the type**

```bash
sed -i -E 's/\bSession\b/SavedSession/g' src/sessions.ts src/app.tsx tests/sessions.test.ts
```

`\b` keeps `SessionStore`, `SessionSummary`, `SessionShape`, `SessionPicker` and `newSession` intact.

- [ ] **Step 2: Check nothing else used it**

Run: `grep -rnw Session src tests`
Expected: no output.

- [ ] **Step 3: Typecheck and run the affected tests**

Run: `bun run typecheck && bun test tests/sessions tests/app`
Expected: typecheck clean; all pass.

- [ ] **Step 4: Commit**

```bash
git add src/sessions.ts src/app.tsx tests/sessions.test.ts
git commit -m "Rename the saved-file Session type to SavedSession

The SDK's public Session (the live object you send messages to) needs the
name; what sessions.ts describes is what's on disk."
```

---

### Task 3: With no approver, yolo still runs what it vouches for

Today `runTool` refuses every gated call when `ctx.approve` is missing, before yolo is even consulted. An SDK session without an approver should behave like the CLI's defaults: yolo-safe calls run, the rest are refused with an error the model can read.

**Files:**
- Create: `tests/no-approver.test.ts`
- Modify: `src/tools/index.ts:58-80`

- [ ] **Step 1: Write the failing test**

Create `tests/no-approver.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../src/tools/index.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-no-approver-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const write = (path: string) => ({ id: "c1", name: "write_file", arguments: JSON.stringify({ path, content: "hi\n" }) });

test("with no one to ask, yolo still runs what it vouches for", async () => {
  const result = await runTool(write("a.txt"), { root, yolo: true });
  expect(result).toMatchObject({ approval: "auto" });
  expect(existsSync(join(root, "a.txt"))).toBe(true);
});

test("with no one to ask, anything else is refused, as an error the model can read", async () => {
  const result = await runTool(write("a.txt"), { root, yolo: false });
  expect(result).toMatchObject({ isError: true, output: "write_file needs the user's approval, and there's no one to ask." });
  expect(existsSync(join(root, "a.txt"))).toBe(false);
});
```

- [ ] **Step 2: Run it to see the first test fail**

Run: `bun test tests/no-approver`
Expected: the first test FAILS (the result is the "no one to ask" error, not `approval: "auto"`); the second passes.

- [ ] **Step 3: Move the check after yolo**

In `src/tools/index.ts`, inside `runTool`, delete this line (the first statement inside `if (gated) {`):

```ts
      if (!ctx.approve) return fail(`${call.name} needs the user's approval, and there's no one to ask.`, label);
```

and insert it, with a comment, right after the yolo block, so the end of that region reads:

```ts
      if (ctx.yolo && tool.autoSafe?.(parsed.data, ctx)) {
        return { ...(await tool.run(parsed.data, { ...ctx, callId: call.id, confined: true })), label, approval: "auto" };
      }
      // No one to ask (a program using the SDK without an approver): refused, as an error the model can read and
      // work around, rather than a "no" that would stop the run.
      if (!ctx.approve) return fail(`${call.name} needs the user's approval, and there's no one to ask.`, label);
      const decision = await ctx.approve({ tool: call.name, label, preview, scope, ...network });
```

- [ ] **Step 4: Add `specOf` while in this file** (the session offers custom tools with it, Task 8)

Replace the `toolSpecs` definition:

```ts
export const toolSpecs: ToolSpec[] = tools.map((tool) => {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, parameters };
});
```

with:

```ts
export const toolSpecs: ToolSpec[] = tools.map(specOf);

/** A tool as the model is told about it: name, description, and its input as JSON schema. */
export function specOf(tool: Tool): ToolSpec {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, parameters };
}
```

(The doc comment above `toolSpecs`, "What the model is told about each tool. Built once…", stays where it is.)

- [ ] **Step 5: Run the tests**

Run: `bun test tests/no-approver tests/tools tests/yolo tests/agent-tool`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts tests/no-approver.test.ts
git commit -m "runTool: with no approver, yolo-safe calls still run

A program using Marv without an approver should get the CLI's defaults:
edits outside .git and sandboxed offline commands run, anything else comes
back as an error the model can work around. Before, every gated call was
refused before yolo was asked. Also: specOf(), for tools given in code."
```

---

### Task 4: `EventQueue`

A turn's events come from two places: the main loop's iterator, and subagents' callbacks, which fire while the main loop is waiting on the `agent` call. The queue merges them into one ordered stream. One reader; pushes after `close()` are dropped (a subagent still winding down after its turn ended must not resurrect it).

**Files:**
- Create: `src/event-queue.ts`, `tests/event-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/event-queue.test.ts`:

```ts
import { expect, test } from "bun:test";
import { EventQueue } from "../src/event-queue.ts";

async function drain<T>(queue: EventQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of queue) out.push(item);
  return out;
}

test("delivers what was pushed, in order, and ends once closed and empty", async () => {
  const queue = new EventQueue<number>();
  queue.push(1);
  queue.push(2);
  const done = drain(queue);
  queue.push(3);
  queue.close();
  expect(await done).toEqual([1, 2, 3]);
});

test("a waiting reader gets the next item as soon as it's pushed", async () => {
  const queue = new EventQueue<string>();
  const next = queue[Symbol.asyncIterator]().next();
  queue.push("a");
  expect(await next).toEqual({ value: "a", done: false });
});

test("pushes after close are dropped (a subagent still winding down after its turn ended)", async () => {
  const queue = new EventQueue<number>();
  queue.push(1);
  queue.close();
  queue.push(2);
  expect(await drain(queue)).toEqual([1]);
});

test("closing wakes a waiting reader", async () => {
  const queue = new EventQueue<number>();
  const done = drain(queue);
  await Bun.sleep(0);
  queue.close();
  expect(await done).toEqual([]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/event-queue`
Expected: FAIL, "Cannot find module '../src/event-queue.ts'".

- [ ] **Step 3: Write the queue**

Create `src/event-queue.ts`:

```ts
// A queue you push to from callbacks and read with `for await`: how a session merges the events of a turn's
// main loop (an iterator) with its subagents' (callbacks that fire while the main loop waits on them) into one
// ordered stream. One reader. It never applies back-pressure: callbacks can't be told to wait, and the events
// are small.

export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T, undefined>) => void) | null = null;
  private closed = false;

  /** Adds an item; dropped once the queue is closed (the stream it belonged to is over). */
  push(item: T): void {
    if (this.closed) return;
    const reader = this.waiting;
    if (reader) {
      this.waiting = null;
      reader({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** No more items: the reader gets what's queued, then the iteration ends. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const reader = this.waiting;
    this.waiting = null;
    reader?.({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T, undefined>>((resolve) => (this.waiting = resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}
```

- [ ] **Step 4: Run the test**

Run: `bun test tests/event-queue`
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/event-queue.ts tests/event-queue.test.ts
git commit -m "EventQueue: one stream from an iterator and callbacks

A turn's events come from the main loop and, while it waits on a subagent,
from that subagent's callbacks. The session pushes both into this queue so
its client reads one ordered stream."
```

---

### Task 5: Load only the sources asked for

`createSession()` reads nothing unless asked: `"user"` is everything under `~/.marv` (personal skills and agents, memory, `mcp.json`), `"project"` is what's in the repository (`AGENTS.md`, `.marv/skills`, `.marv/agents`, `.mcp.json`). The loaders today always read both, so they learn to read either. Also: MCP servers given in code (`mcpServers`) need parsing like `.mcp.json` entries.

**Files:**
- Create: `src/sources.ts`, `tests/sources.test.ts`
- Modify: `src/skills.ts:65-85`, `src/agents.ts:91-115`, `src/mcp/config.ts:190-205` (and add `parseMcpServers`)

- [ ] **Step 1: Write the failing test**

Create `tests/sources.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMcpServers } from "../src/mcp/config.ts";
import { loadSources, type Source } from "../src/sources.ts";

let base: string;
let home: string;
let configDir: string;
let root: string;

async function skill(dir: string, name: string) {
  await mkdir(join(dir, ".marv", "skills", name), { recursive: true });
  await writeFile(join(dir, ".marv", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo it.`);
}
async function agent(dir: string, name: string) {
  await mkdir(join(dir, ".marv", "agents"), { recursive: true });
  await writeFile(join(dir, ".marv", "agents", `${name}.md`), `---\nname: ${name}\ndescription: The ${name} agent\n---\nYou are ${name}.`);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "marv-sources-"));
  home = join(base, "home");
  configDir = join(home, ".marv");
  root = join(base, "project");
  await skill(home, "mine");
  await skill(root, "theirs");
  await agent(home, "my-agent");
  await agent(root, "their-agent");
  await writeFile(join(root, "AGENTS.md"), "Project rules.");
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { theirs: { command: "echo" } } }));
  await writeFile(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "echo" } } }));
  await mkdir(join(configDir, "memory"), { recursive: true });
  await writeFile(join(configDir, "memory", "personal.md"), "- The user likes tabs\n");
});
afterEach(() => rm(base, { recursive: true, force: true }));

const load = (sources: Source[]) => loadSources({ root, sources, configDir, home, env: {} });
const names = (list: { name: string }[]) => list.map((x) => x.name);

test("nothing asked, nothing read", async () => {
  const loaded = await load([]);
  expect(loaded.instructions).toBeUndefined();
  expect(loaded.skills).toEqual([]);
  expect(names(loaded.agents)).toEqual(["general-purpose"]);
  expect(loaded.memory).toBeUndefined();
  expect(loaded.mcpServers).toEqual([]);
  expect(loaded.problems).toEqual([]);
});

test("user: your skills, agents, memory and MCP servers; nothing from the repository", async () => {
  const loaded = await load(["user"]);
  expect(names(loaded.skills)).toEqual(["mine"]);
  expect(names(loaded.agents)).toEqual(["general-purpose", "my-agent"]);
  expect(loaded.memory?.initial.personal).toEqual(["The user likes tabs"]);
  expect(names(loaded.mcpServers)).toEqual(["mine"]);
  expect(loaded.instructions).toBeUndefined();
});

test("project: the repository's AGENTS.md, skills, agents and .mcp.json; nothing of yours", async () => {
  const loaded = await load(["project"]);
  expect(loaded.instructions).toBe("Project rules.");
  expect(names(loaded.skills)).toEqual(["theirs"]);
  expect(names(loaded.agents)).toEqual(["general-purpose", "their-agent"]);
  expect(names(loaded.mcpServers)).toEqual(["theirs"]);
  expect(loaded.memory).toBeUndefined();
});

test("both: what the CLI loads", async () => {
  const loaded = await load(["user", "project"]);
  expect(names(loaded.skills)).toEqual(["mine", "theirs"]);
  expect(names(loaded.mcpServers)).toEqual(["mine", "theirs"]);
  expect(loaded.instructions).toBe("Project rules.");
});

test("servers given in code are parsed like .mcp.json entries, and trusted like yours", () => {
  const { servers, problems } = parseMcpServers({ fs: { command: "npx", args: ["-y", "server-fs", "${DIR}"] }, bad__name: { command: "x" } }, { DIR: "/data" });
  expect(servers).toEqual([expect.objectContaining({ name: "fs", source: "personal", transport: { type: "stdio", command: "npx", args: ["-y", "server-fs", "/data"] } })]);
  expect(problems).toEqual([expect.stringContaining("bad__name")]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/sources`
Expected: FAIL, "Cannot find module '../src/sources.ts'" (and `parseMcpServers` isn't exported).

- [ ] **Step 3: Skills: either base can be left out**

In `src/skills.ts`, change `loadSkills`'s doc comment, signature and loop start:

```ts
/** Loads personal skills (under `home`), then project skills (under `root`; they win a name clash). Either can be left out. Skips broken ones, saying why. */
export async function loadSkills({ root, home }: { root?: string; home?: string }): Promise<{ skills: Skill[]; problems: string[] }> {
```

and, as the first line inside `for (const { base, source, prefix } of sources) {`:

```ts
    if (base === undefined) continue;
```

- [ ] **Step 4: Agents: the same**

In `src/agents.ts`, `loadAgents`:

```ts
/** Built-in, then personal (under `home`), then project agents (under `root`; later wins a name clash). Either can be left out. Skips broken ones, saying why. */
export async function loadAgents({ root, home }: { root?: string; home?: string }): Promise<{ agents: AgentType[]; problems: string[] }> {
```

and, as the first line inside its `for (const { base, source, prefix } of sources) {`:

```ts
    if (base === undefined) continue;
```

- [ ] **Step 5: MCP config: `include`, and `parseMcpServers`**

In `src/mcp/config.ts`, replace `loadMcpConfig`'s signature and its two reads:

```ts
/** The servers to connect to (yours first, then the project's), and what couldn't be read, and why. `include` leaves either file out. */
export async function loadMcpConfig({
  root,
  configDir,
  env: outer,
  include = { personal: true, project: true },
}: {
  root: string;
  configDir: string;
  env: Env;
  include?: { personal: boolean; project: boolean };
}) {
  const problems: string[] = [];
  // Servers of yours start in your home folder (see McpManager.cwdFor); one that works on the project gets it this way.
  const env = { ...outer, MARV_PROJECT_DIR: root };
  const projectPath = join(root, PROJECT_FILE);
  const project = include.project ? await readFile(projectPath, "project", env, problems) : [];
  const personal = include.personal ? await readFile(join(configDir, PERSONAL_FILE), "personal", env, problems) : [];
```

(The rest of the function is unchanged.) Then add, after `loadMcpConfig`:

```ts
/**
 * Servers given in code (the SDK's `mcpServers`), in .mcp.json's format. Trusted like your own: whoever wrote the
 * program chose them, so they never wait for /mcp trust.
 */
export function parseMcpServers(entries: Record<string, unknown>, env: Env): { servers: McpServerConfig[]; problems: string[] } {
  const servers: McpServerConfig[] = [];
  const problems: string[] = [];
  for (const [name, raw] of Object.entries(entries)) {
    try {
      servers.push(parseServer(name, raw, "personal", env, "mcpServers"));
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return { servers, problems };
}
```

- [ ] **Step 6: `loadSources`**

Create `src/sources.ts`:

```ts
// What a session can read from disk, by where it lives (the SDK's `sources`):
//
//   "user"     your ~/.marv: personal skills and agents, memory (personal and this project's: both are your own
//              files, never in the repository), and your MCP servers (mcp.json).
//   "project"  the repository: AGENTS.md, .marv/skills, .marv/agents, and .mcp.json (whose servers still start
//              only once you've trusted them, with /mcp trust in the CLI).
//
// The CLI loads both (src/cli.tsx, through the loaders directly). A program using the SDK loads neither unless it
// asks: a library mustn't quietly read your files, or start a repository's servers.
import { homedir } from "node:os";
import { loadAgents, type AgentType } from "./agents.ts";
import type { Env } from "./config/config.ts";
import { loadMcpConfig, type McpServerConfig } from "./mcp/config.ts";
import { loadMemory, memoryPaths, type Memories, type MemoryPaths } from "./memory.ts";
import { loadInstructions } from "./prompt.ts";
import { loadSkills, type Skill } from "./skills.ts";

export type Source = "user" | "project";

export interface Loaded {
  instructions?: string;
  skills: Skill[];
  /** Always has the built-in general-purpose type. */
  agents: AgentType[];
  memory?: { paths: MemoryPaths; initial: Memories };
  mcpServers: McpServerConfig[];
  /** Files that couldn't be read, and why. */
  problems: string[];
}

export async function loadSources({
  root,
  sources,
  configDir,
  home = homedir(),
  env = process.env,
}: {
  root: string;
  sources: Source[];
  /** ~/.marv (or $MARV_CONFIG_DIR): memory and mcp.json live here. */
  configDir: string;
  /** Personal skills and agents live in <home>/.marv. */
  home?: string;
  env?: Env;
}): Promise<Loaded> {
  const user = sources.includes("user");
  const project = sources.includes("project");
  const bases = { root: project ? root : undefined, home: user ? home : undefined };
  const { skills, problems: skillProblems } = await loadSkills(bases);
  const { agents, problems: agentProblems } = await loadAgents(bases);
  const mcp = user || project ? await loadMcpConfig({ root, configDir, env, include: { personal: user, project } }) : { servers: [], problems: [] };
  const paths = memoryPaths(configDir, root);
  return {
    instructions: project ? await loadInstructions(root) : undefined,
    skills,
    agents,
    memory: user ? { paths, initial: await loadMemory(paths) } : undefined,
    mcpServers: mcp.servers,
    problems: [...skillProblems, ...agentProblems, ...mcp.problems],
  };
}
```

- [ ] **Step 7: Run the tests**

Run: `bun test tests/sources tests/skills tests/agents tests/mcp-config && bun run typecheck`
Expected: all pass; typecheck clean (`src/cli.tsx` still passes both `root` and `home`).

- [ ] **Step 8: Commit**

```bash
git add src/sources.ts src/skills.ts src/agents.ts src/mcp/config.ts tests/sources.test.ts
git commit -m "Load only the sources asked for: yours, the project's, or neither

createSession() will read nothing from disk unless asked: a library mustn't
quietly read ~/.marv or start a repository's MCP servers. The loaders learn
to skip either side; parseMcpServers() takes servers given in code."
```

---

### Task 6: Provider factory, and `agentArgs` moves to `agent.ts`

A session needs more than one `Provider`: subagent types can name another model, and on OpenRouter the provider is remade once the model list says whether reasoning can be turned off. A `ProviderFactory` makes them. The TUI builds one from its `Config` (with the `makeProvider`/`loadModels` its tests inject); the SDK from a `ProviderOption`.

**Files:**
- Create: `src/provider/factory.ts`, `tests/provider-factory.test.ts`
- Modify: `src/agent.ts` (add `agentArgs`), `src/app.tsx` (import it instead of defining it)

- [ ] **Step 1: Write the failing test**

Create `tests/provider-factory.test.ts`:

```ts
import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config/config.ts";
import { configFactory, isFactory, providerFactory } from "../src/provider/factory.ts";
import { OllamaProvider } from "../src/provider/ollama.ts";
import { OpenAICompatProvider } from "../src/provider/openai-compat.ts";
import { ScriptedProvider } from "./fake-provider.ts";

test("an OpenRouter option makes an OpenRouter provider, and can look the model up", () => {
  const factory = providerFactory({ kind: "openrouter", apiKey: "sk-test", model: "x/y" });
  expect(factory).toMatchObject({ id: "openrouter", model: "x/y", local: false });
  const provider = factory.make();
  expect(provider).toBeInstanceOf(OpenAICompatProvider);
  expect(provider.name).toBe("openrouter · x/y");
  expect(factory.lookup).toBeDefined();
});

test("an Ollama option is local, with its host and context window, and nothing to look up", () => {
  const factory = providerFactory({ kind: "ollama", model: "qwen3.5:9b", host: "gpu-box:11434", contextLength: 65536 });
  expect(factory).toMatchObject({ id: "ollama", model: "qwen3.5:9b", local: true });
  const provider = factory.make();
  expect(provider).toBeInstanceOf(OllamaProvider);
  expect(provider.contextLength).toBe(65536);
  expect(factory.lookup).toBeUndefined();
});

test("a Provider of your own is used as is, also for subagents", () => {
  const own = new ScriptedProvider([]);
  const factory = providerFactory(own);
  expect(factory).toMatchObject({ id: "custom", model: "scripted" });
  expect(factory.make()).toBe(own);
  expect(factory.make("another/model")).toBe(own);
});

test("configFactory: the TUI's config, with the maker and model list it was given", async () => {
  const config = { ...resolveConfig({ provider: "openrouter", model: "a/b", apiKey: "k" }, {}), thinking: true };
  const made: unknown[] = [];
  const factory = configFactory(
    config,
    (c, info) => (made.push([c.model, c.thinking, info]), new ScriptedProvider([])),
    async () => [{ id: "a/b", context: 1000 }, { id: "c/d" }],
  );
  factory.make();
  factory.make("c/d");
  factory.make(undefined, { reasoning: "optional" });
  expect(made).toEqual([
    ["a/b", true, undefined],
    ["c/d", true, undefined],
    ["a/b", true, { reasoning: "optional" }],
  ]);
  expect(await factory.lookup!()).toEqual({ id: "a/b", context: 1000 });
  expect(isFactory(factory)).toBe(true);
  expect(isFactory(new ScriptedProvider([]))).toBe(false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/provider-factory`
Expected: FAIL, "Cannot find module '../src/provider/factory.ts'".

- [ ] **Step 3: Write the factory**

Create `src/provider/factory.ts`:

```ts
// How a session gets its providers. It needs more than one Provider object: a subagent type can name another
// model, and on OpenRouter the provider is remade once the model list says whether the model's reasoning can be
// turned off (/think). A factory makes them, and says what to record in saved sessions and trajectories.
import { resolveConfig, type Config } from "../config/config.ts";
import { createProvider } from "./index.ts";
import { listModels, type ModelInfo } from "./models.ts";
import type { Provider } from "./types.ts";

export interface ProviderFactory {
  /** Recorded with sessions and trajectories: "openrouter", "ollama", or "custom". */
  id: string;
  model: string;
  /** Runs on this machine (Ollama): no cost. */
  local?: boolean;
  /** The session's provider; `model` for a subagent type that names another one; `info` once the model list was read. */
  make(model?: string, info?: Pick<ModelInfo, "reasoning">): Provider;
  /** What the provider's model list says about the model (context window, prices, reasoning), when it has a list. */
  lookup?(): Promise<ModelInfo | undefined>;
}

/** What the SDK takes: a built-in provider by name, or any Provider of your own. */
export type ProviderOption =
  | { kind: "openrouter"; apiKey: string; model?: string; baseUrl?: string }
  | { kind: "ollama"; model: string; host?: string; contextLength?: number }
  | Provider;

export const isFactory = (value: ProviderFactory | ProviderOption): value is ProviderFactory =>
  typeof (value as ProviderFactory).make === "function";

/** The TUI's way: from its resolved Config, with the provider maker and model list it was given (tests swap both). */
export function configFactory(
  config: Config,
  make: (config: Config, info?: Pick<ModelInfo, "reasoning">) => Provider = createProvider,
  load: (config: Pick<Config, "provider" | "baseUrl">) => Promise<ModelInfo[]> = listModels,
): ProviderFactory {
  return {
    id: config.provider,
    model: config.model,
    local: config.provider === "ollama",
    make: (model, info) => make(model ? { ...config, model } : config, info),
    // OpenRouter's list has every model's context window, prices and reasoning; Ollama's knows none of that.
    lookup: config.provider === "openrouter" ? () => load(config).then((models) => models.find((m) => m.id === config.model)) : undefined,
  };
}

/** The SDK's way. Environment variables (OPENROUTER_API_KEY, MARV_MODEL…) are ignored: a library uses what it's given. */
export function providerFactory(option: ProviderOption, thinking = false): ProviderFactory {
  if ("stream" in option) return { id: "custom", model: option.name, make: () => option };
  const file =
    option.kind === "openrouter"
      ? { provider: "openrouter" as const, apiKey: option.apiKey, model: option.model, baseUrl: option.baseUrl }
      : { provider: "ollama" as const, model: option.model, contextLength: option.contextLength };
  const env = option.kind === "ollama" && option.host ? { OLLAMA_HOST: option.host } : {};
  return configFactory({ ...resolveConfig(file, env), thinking });
}
```

- [ ] **Step 4: Move `agentArgs` to `src/agent.ts`**

Delete the `agentArgs` function (and its doc comment) from the top of `src/app.tsx`, and add it to `src/agent.ts` right after `agentLabel`:

```ts
/** What an agent call asked for: its task (the first entry in its view) and the rest, for its trajectory. */
export function agentArgs(args: string): { prompt: string; type: string; description: string; isolation?: string } {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(args);
    // The model can send any JSON ("null", "[]", "3"): only an object has fields. runTool reports the bad input.
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {}
  const text = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
  return { prompt: text("prompt") ?? "", type: text("type") ?? "general-purpose", description: text("description") ?? "", isolation: text("isolation") };
}
```

In `src/app.tsx`, change the agent import to:

```ts
import { agentArgs, answerAllCalls, DEFAULT_MAX_STEPS, runAgent } from "./agent.ts";
```

- [ ] **Step 5: Run the tests**

Run: `bun test tests/provider-factory tests/app && bun run typecheck`
Expected: all pass; clean.

- [ ] **Step 6: Commit**

```bash
git add src/provider/factory.ts src/agent.ts src/app.tsx tests/provider-factory.test.ts
git commit -m "ProviderFactory: one way to make a session's providers

A session makes several providers: one per subagent model, and a new one
when OpenRouter's model list says whether reasoning can be turned off. The
TUI builds the factory from its Config, the SDK from a ProviderOption.
agentArgs moves to agent.ts: the session will record subagents with it."
```

---

### Task 7: `MarvSession`, and the turn lifecycle

The class that takes over from `App.send()`. This task writes the whole of `src/session.ts`: it's a port of logic that exists today (the App's `send`, `compact`, `trajectory`, `restore`, `saveSession`), so splitting it would mean rewriting `runTurn` several times. The tests here cover what's new (the event stream, its guarantees, the busy rule); Tasks 8 to 11 pin the ported behavior.

**Files:**
- Create: `src/session.ts`, `tests/session.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/session.test.ts` (later tasks add `describe` blocks to it):

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpManager } from "../src/mcp/manager.ts";
import { addMemory, loadMemory, memoryPaths } from "../src/memory.ts";
import type { ProviderFactory } from "../src/provider/factory.ts";
import type { AgentEvent, ChatTurn, Provider, StreamOptions, ToolCall, ToolSpec } from "../src/provider/types.ts";
import { MarvSession, type SessionEvent, type SessionInit } from "../src/session.ts";
import { SessionStore, type SavedSession } from "../src/sessions.ts";
import { TrajectoryStore } from "../src/trajectory.ts";
import type { ApprovalRequest, Decision } from "../src/tools/types.ts";
import { RoutedProvider, ScriptedProvider } from "./fake-provider.ts";

const say = (text: string): AgentEvent[] => [
  { type: "text_delta", text },
  { type: "done", reason: "stop" },
];
const useTools = (...calls: ToolCall[]): AgentEvent[] => [...calls.map((c) => ({ type: "tool_call" as const, call: c })), { type: "done", reason: "tool_calls" }];
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const read = (id: string) => call(id, "read_file", { path: "notes.txt" });
const fixed = (provider: Provider, extra: Partial<ProviderFactory> = {}): ProviderFactory => ({ id: "test", model: "test-model", make: () => provider, ...extra });

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
const types = (events: SessionEvent[]) => events.map((e) => e.type);

/** Tool calls in a history without a result: a request with one is rejected by the API. */
function unanswered(history: ChatTurn[]): string[] {
  const calls = history.flatMap((t) => (t.role === "assistant" ? (t.toolCalls ?? []).map((c) => c.id) : []));
  const answered = new Set(history.flatMap((t) => (t.role === "tool" ? [t.callId] : [])));
  return calls.filter((id) => !answered.has(id));
}

/** A model that says something, then works until it's stopped. */
class Hanging implements Provider {
  readonly name = "hanging";
  requests = 0;
  async *stream(_history: ChatTurn[], { signal }: StreamOptions = {}): AsyncIterable<AgentEvent> {
    this.requests++;
    yield { type: "text_delta", text: "Working" };
    await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
    yield { type: "done" };
  }
}

let project: string;
let dir: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "marv-session-project-"));
  dir = await mkdtemp(join(tmpdir(), "marv-session-"));
  await writeFile(join(project, "notes.txt"), "remember the milk\n");
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

function makeSession(provider: Provider | ProviderFactory, init: Partial<SessionInit> = {}): MarvSession {
  return new MarvSession({ root: project, provider: "make" in provider ? provider : fixed(provider), ...init });
}

describe("a turn", () => {
  test("starts with turn_start, ends with turn_end, and streams the reply in between", async () => {
    const events = await collect(makeSession(new ScriptedProvider([say("Hello.")])).send("hi"));
    expect(types(events)).toEqual(["turn_start", "status", "text_delta", "assistant", "done", "turn_end"]);
    const start = events[0] as Extract<SessionEvent, { type: "turn_start" }>;
    expect(events.at(-1)).toEqual({ type: "turn_end", turn: start.turn, reason: "end" });
  });

  test("one at a time: send() during a turn throws; the next can start once it ended", async () => {
    const provider = new ScriptedProvider([say("One."), say("Two.")]);
    const session = makeSession(provider);
    const first = session.send("one");
    expect(session.busy).toBe(true);
    expect(() => session.send("two")).toThrow(/working/);
    await collect(first);
    expect(session.busy).toBe(false);
    await collect(session.send("two"));
    expect(provider.requests.map((r) => r.history.at(-1)?.text)).toEqual(["one", "two"]);
  });

  test("interrupt() stops the running turn", async () => {
    const session = makeSession(new Hanging());
    const events: SessionEvent[] = [];
    for await (const event of session.send("go")) {
      events.push(event);
      if (event.type === "text_delta") session.interrupt();
    }
    expect(events).toContainEqual({ type: "done", reason: "aborted" });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
  });

  test("so does the signal passed to send()", async () => {
    const stop = new AbortController();
    const events: SessionEvent[] = [];
    for await (const event of makeSession(new Hanging()).send("go", { signal: stop.signal })) {
      events.push(event);
      if (event.type === "text_delta") stop.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
  });

  test("leaving the loop early interrupts the turn, and every tool call still gets a result", async () => {
    const provider = new ScriptedProvider([useTools(read("c1"), read("c2")), say("Next.")]);
    const session = makeSession(provider);
    for await (const event of session.send("read it twice")) if (event.type === "tool_start") break;
    expect(session.busy).toBe(false);
    await collect(session.send("next"));
    expect(unanswered(provider.requests[1]!.history)).toEqual([]);
  });

  test("usage adds up, and the last request's size is kept", async () => {
    const provider = new ScriptedProvider([[{ type: "usage", usage: { promptTokens: 100, completionTokens: 20 } }, ...say("Hi.")]]);
    const session = makeSession(fixed(provider, { local: true }));
    await collect(session.send("hi"));
    expect(session.usage()).toMatchObject({
      last: { promptTokens: 100, completionTokens: 20 },
      totals: { requests: 1, promptTokens: 100, completionTokens: 20, local: true },
    });
  });

  test("a provider error ends the turn with reason error", async () => {
    const events = await collect(makeSession(new ScriptedProvider([[{ type: "error", message: "bad key" }]])).send("hi"));
    expect(events).toContainEqual({ type: "error", message: "bad key" });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "error" });
  });

  test("a provider that throws ends the turn, not the session", async () => {
    const broken: Provider = {
      name: "broken",
      stream: () => {
        throw new Error("kaput");
      },
    };
    const session = makeSession(broken);
    const events = await collect(session.send("hi"));
    expect(events).toContainEqual({ type: "error", message: "Error: kaput" });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "error" });
    expect(session.busy).toBe(false);
  });

  test("systemPrompt replaces Marv's, or adds to it", async () => {
    const replaced = new ScriptedProvider([say("ok")]);
    await collect(makeSession(replaced, { systemPrompt: "You are a pirate." }).send("hi"));
    expect(replaced.requests[0]!.options.system).toBe("You are a pirate.");
    const appended = new ScriptedProvider([say("ok")]);
    await collect(makeSession(appended, { systemPrompt: { append: "Answer briefly." } }).send("hi"));
    expect(appended.requests[0]!.options.system).toStartWith("You are Marv");
    expect(appended.requests[0]!.options.system).toEndWith("Answer briefly.");
  });
});
```

Some imports (`existsSync`, `readFile`, `McpManager`, `addMemory`, …) are only used by the tests later tasks add; that's fine for `bun test`, and `tsc` doesn't flag unused imports in this config.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/session`
Expected: FAIL, "Cannot find module '../src/session.ts'".

- [ ] **Step 3: Write the session**

Create `src/session.ts`:

```ts
// The headless Marv session: everything that turns the agent loop (runAgent, src/agent.ts) into Marv, with no
// UI. It holds the conversation (what the model sees), builds the system prompt and tool list once per
// conversation, waits for MCP servers, compacts when the context is nearly full, starts subagents, records
// trajectories, saves the session, and hands each turn back as a stream of events. The TUI (src/app.tsx) is one
// client of it; the SDK (src/sdk.ts) gives it to other programs.
//
// One turn at a time: send() while a turn runs throws. The history is only appended to (compaction is the one
// exception), and the system prompt and tool specs stay the same objects for a whole conversation: that's what
// keeps the provider's prompt cache hitting (see CLAUDE.md, "Prompt cache").
import { agentArgs, answerAllCalls, DEFAULT_MAX_STEPS, runAgent, type LoopEvent } from "./agent.ts";
import { GENERAL_PURPOSE, type AgentType } from "./agents.ts";
import { COMPACT_AT, compactedHistory, summarize } from "./compact.ts";
import { EventQueue } from "./event-queue.ts";
import { classifyReply } from "./feedback.ts";
import { runGit } from "./git.ts";
import type { McpManager } from "./mcp/manager.ts";
import { loadMemory, type Memories, type MemoryPaths } from "./memory.ts";
import { shortenHome } from "./paths.ts";
import { systemPrompt } from "./prompt.ts";
import { isFactory, providerFactory, type ProviderFactory, type ProviderOption } from "./provider/factory.ts";
import type { ModelInfo } from "./provider/models.ts";
import type { ChatTurn, Provider, ToolSpec, Usage } from "./provider/types.ts";
import { newSession, type SavedSession, type SessionStore } from "./sessions.ts";
import type { Skill } from "./skills.ts";
import { AgentRecorder, type Trajectory, type TrajectoryRecord, type TrajectoryStore } from "./trajectory.ts";
import { isParallelCall, runTool, specOf, tools as builtinTools, toolSpecsFor } from "./tools/index.ts";
import type { AgentHost, AgentProgress, ApprovalRequest, Decision, Tool } from "./tools/types.ts";
import type { Message } from "./types.ts";
import { addUsage, emptyTotals, type Totals } from "./usage.ts";

/** How a turn ended: how the agent loop ended, or "interrupted" when it was stopped before the loop began. */
export type TurnEndReason = Extract<LoopEvent, { type: "done" }>["reason"] | "interrupted";

export type CompactResult =
  | { compacted: true; summary: string; tokensBefore?: number }
  | { compacted: false; reason: "empty" | "stopped" | "failed"; error: string };

export type SessionEvent =
  /** Always first. */
  | { type: "turn_start"; turn: string }
  /** What the turn is doing before (or instead of) the model's reply. */
  | { type: "status"; status: "waiting_for_mcp" | "compacting" | "running" }
  /** The main agent, exactly as runAgent yields them. */
  | LoopEvent
  /** A subagent's loop event; `callId` is the agent tool call that started it. */
  | { type: "subagent"; callId: string; event: LoopEvent }
  | { type: "subagent_progress"; callId: string; progress: AgentProgress }
  /** An automatic compaction (the context was nearly full), and how it went. */
  | { type: "compaction"; result: CompactResult }
  /** Always last, exactly once, however the turn ended. */
  | { type: "turn_end"; turn: string; reason: TurnEndReason };

/** A saved session, brought back. */
export interface Resumed {
  id: string;
  updatedAt: number;
  model: string;
  /** What the user saw (the client's transcript when it gave one, otherwise the messages and replies). */
  transcript: Message[];
  totals: Totals;
}

export interface SessionInit {
  /** Absolute project root: the tools can't reach outside it. */
  root: string;
  /** Shown to the model ("~/Projects/app"); default: the root, with the home folder shortened. */
  cwd?: string;
  provider: ProviderFactory | ProviderOption;
  /** For a ProviderOption: let thinking models reason first. (A factory has it built in.) */
  thinking?: boolean;
  /** Marv's version, for trajectories. */
  version?: string;
  /** The project's AGENTS.md. */
  instructions?: string;
  skills?: Skill[];
  /** Agent types the agent tool can start (default: general-purpose). */
  agents?: AgentType[];
  memory?: { paths: MemoryPaths; initial: Memories };
  /** MCP servers, already starting; their tools join the built-in ones once they're ready. */
  mcp?: McpManager;
  /** close() closes the MCP servers (the session started them; the CLI closes its own). */
  ownsMcp?: boolean;
  /** Extra tools, offered after the built-in ones. */
  tools?: Tool[];
  /** Replaces Marv's system prompt, or appends to it. */
  systemPrompt?: string | { append: string };
  /** Asked for every call that needs a yes; without it, only what yolo vouches for runs. */
  approve?: (request: ApprovalRequest) => Promise<Decision>;
  sandbox?: boolean;
  yolo?: boolean;
  sessions?: SessionStore;
  trajectories?: TrajectoryStore;
  /** Whether to log to `trajectories` (default true); configure({ trajectories }) changes it. */
  logTrajectories?: boolean;
  /** Where worktree subagents work (~/.marv/worktrees/<project>); without it, no worktrees. */
  worktreesDir?: string;
  /** What the user saw, saved with the session (the TUI's transcript); default: the messages and replies. */
  transcript?: () => Message[];
  /** Something a UI shows changed outside a turn: the model's info arrived, memory was reloaded. */
  onChange?: () => void;
  /** Something the user should hear about (a trajectory that can't be written). */
  onWarning?: (text: string) => void;
  /** Config files that couldn't be read, for the client to show. */
  problems?: string[];
}

const DEFAULT_AGENTS: AgentType[] = [GENERAL_PURPOSE];
/** Saved this long after a turn ends (and again on flush), so a burst of turns is one write. */
const SAVE_DELAY_MS = 200;
const BUSY = "Marv is working on a turn: wait for it to end, or interrupt() it, first.";

/** Resolves once the signal fires; at once if it already has. */
const stopped = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));

/** The project's commit, so a trajectory says what code a run started from. */
function gitHead(root: string): string | undefined {
  const head = runGit(root, ["rev-parse", "HEAD"], { timeoutMs: 2000 });
  return head.ok ? head.out.trim() : undefined;
}

/** The step-limit question: asked like any approval, so the client's "stop everything" answers it too. */
const stepLimitRequest = (steps: number): ApprovalRequest => ({
  tool: "continue",
  label: `${steps} steps`,
  preview: {
    title: `Keep going? Marv has taken ${steps} steps on this request without finishing`,
    note: `it asks again after another ${DEFAULT_MAX_STEPS}; no stops it here, and you can say what to do next`,
  },
  scope: { key: "continue", description: "the step limit" },
});

export class MarvSession {
  readonly problems: string[];
  private option: ProviderFactory | ProviderOption;
  private thinking: boolean;
  private factory: ProviderFactory;
  private provider: Provider;
  /** What the model list says about the model, once it has answered. */
  private info: ModelInfo | undefined;
  private lookups = 0;
  /** What the model sees: user and assistant turns, tool calls and their results. */
  private conversation: ChatTurn[] = [];
  /** The file this conversation is saved to (a new one after clear(), the old one after resume()). */
  private saved: SavedSession;
  private totals: Totals = emptyTotals();
  private last: Usage | undefined;
  /** "Yes, don't ask again" scopes, shared by the main agent and its subagents. */
  private readonly always = new Set<string>();
  /** Stops what's running (a turn or a compaction); null when idle. */
  private current: AbortController | null = null;
  private running = false;
  private memories: Memories | undefined;
  /** clear() reloading memory for the next system prompt; the next turn waits for it. */
  private reloading: Promise<void> = Promise.resolve();
  private readonly specs: ToolSpec[];
  private system: string;
  private sandbox: boolean;
  private yolo: boolean;
  private logging: boolean;
  private log: Trajectory | null = null;
  /** The session whose "session" record this process wrote. */
  private sessionLogged: string | null = null;
  /** The latest logged turn: what rate() and the next message's tone rate. */
  private lastTurn: { id: string; session: string } | null = null;
  /** The default transcript (when the client keeps none of its own): what was asked, and the replies. */
  private messages: Message[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly init: SessionInit) {
    this.problems = init.problems ?? [];
    this.option = init.provider;
    this.thinking = init.thinking ?? false;
    this.factory = isFactory(init.provider) ? init.provider : providerFactory(init.provider, this.thinking);
    this.provider = this.factory.make();
    this.sandbox = init.sandbox ?? true;
    this.yolo = init.yolo ?? true;
    this.logging = init.logTrajectories ?? true;
    this.memories = init.memory?.initial;
    // Built once, so every request sends byte-identical tool definitions (the skill tool only when there are skills).
    this.specs = [...toolSpecsFor({ hasSkills: (init.skills?.length ?? 0) > 0 }), ...(init.tools ?? []).map(specOf)];
    this.system = this.buildSystem();
    this.saved = newSession(init.root, { provider: this.factory.id, model: this.factory.model });
    this.lookup();
  }

  get id(): string {
    return this.saved.id;
  }
  /** A turn (or a compaction) is running. */
  get busy(): boolean {
    return this.running;
  }
  /** "openrouter · x/y", for a status bar. */
  get providerName(): string {
    return this.provider.name;
  }
  /** The model's context window in tokens, when known (Ollama's num_ctx, or OpenRouter's model list). */
  get contextLength(): number | undefined {
    return this.provider.contextLength ?? this.info?.context;
  }
  get modelInfo(): ModelInfo | undefined {
    return this.info;
  }
  /** Memory as of the start of this conversation. */
  get memory(): Memories | undefined {
    return this.memories;
  }

  /** The last request's tokens (how full the context is), and the whole session's (survives clear()). */
  usage(): { last?: Usage; totals: Totals; contextLength?: number } {
    return { last: this.last, totals: this.totals, contextLength: this.contextLength };
  }

  /**
   * Runs one turn: the user's message, and everything the agent does until it stops. Iterate the events to the
   * end: nothing starts until you do, and leaving the loop early (break) interrupts the turn. `forModel` is what
   * the model gets when it differs from what the user typed (a /skill's instructions). Throws if a turn is running.
   */
  send(text: string, options: { forModel?: string; signal?: AbortSignal } = {}): AsyncIterable<SessionEvent> {
    this.idle();
    this.running = true;
    const stop = new AbortController();
    this.current = stop;
    return this.turn(text, options.forModel ?? text, stop, options.signal);
  }

  /** Stops the running turn or compaction (Esc). Approvals still waiting are answered "no". */
  interrupt(): void {
    this.current?.abort();
  }

  /** /compact: summarizes the conversation now, and continues from the summary. Rejects during a turn. */
  async compact(focus?: string): Promise<CompactResult> {
    this.idle();
    this.running = true;
    const stop = new AbortController();
    this.current = stop;
    try {
      return await this.summarizeInto(focus, stop.signal);
    } finally {
      this.current = null;
      this.running = false;
      this.scheduleSave();
    }
  }

  /** /clear: a new conversation (and session file), with the memories saved during the last one. Totals stay. */
  clear(): Promise<void> {
    this.idle();
    this.saved = newSession(this.init.root, { provider: this.factory.id, model: this.factory.model });
    this.conversation = [];
    this.messages = [];
    this.last = undefined;
    const memory = this.init.memory;
    this.reloading = (async () => {
      if (memory) this.memories = await loadMemory(memory.paths).catch(() => this.memories);
      this.system = this.buildSystem();
      this.init.onChange?.();
    })();
    return this.reloading;
  }

  /** Brings back a saved session (its id, or the latest here); it keeps saving to the same file. Rejects during a turn. */
  async resume(id: string | "latest"): Promise<Resumed | null> {
    this.idle();
    const store = this.init.sessions;
    if (!store) return null;
    const saved = id === "latest" ? await store.latest(this.init.root) : await store.load(this.init.root, id);
    if (!saved) return null;
    // A turn may have started while it loaded: swapping the conversation under it would mix the two.
    this.idle();
    this.saved = saved;
    this.conversation = [...saved.conversation];
    this.messages = [...saved.transcript];
    this.totals = saved.totals;
    this.last = undefined;
    return { id: saved.id, updatedAt: saved.updatedAt, model: saved.model, transcript: saved.transcript, totals: saved.totals };
  }

  /** New settings. Each turn reads them when it starts, so a change during a turn applies from the next one. */
  configure(changes: {
    provider?: ProviderFactory | ProviderOption;
    thinking?: boolean;
    sandbox?: boolean;
    yolo?: boolean;
    trajectories?: boolean;
  }): void {
    if (changes.sandbox !== undefined) this.sandbox = changes.sandbox;
    if (changes.yolo !== undefined) this.yolo = changes.yolo;
    if (changes.trajectories !== undefined) this.logging = changes.trajectories;
    if (changes.provider === undefined && changes.thinking === undefined) return;
    if (changes.provider !== undefined) this.option = changes.provider;
    if (changes.thinking !== undefined) this.thinking = changes.thinking;
    const next = isFactory(this.option) ? this.option : providerFactory(this.option, this.thinking);
    // Same model (a /think or /yolo): what the list said about it still holds, so the provider keeps its reasoning switch.
    if (next.id !== this.factory.id || next.model !== this.factory.model) this.info = undefined;
    this.factory = next;
    this.provider = next.make(undefined, this.info?.reasoning ? { reasoning: this.info.reasoning } : undefined);
    this.lookup();
  }

  /** /good, /bad, /label: feedback on the last turn, in its trajectory. */
  rate({ score, note, labels }: { score: 1 | -1 | 0; note?: string; labels?: string[] }): "rated" | "off" | "nothing" {
    const log = this.trajectory();
    if (!log) return "off";
    if (!this.lastTurn || this.lastTurn.session !== log.session) return "nothing";
    log.write({ type: "feedback", turn: this.lastTurn.id, score, source: "explicit", ...(labels ? { labels } : {}), ...(note ? { note } : {}) });
    return "rated";
  }

  /** Saves the conversation now (it's also saved shortly after every turn). */
  async save(): Promise<void> {
    const store = this.init.sessions;
    if (!store) return;
    const transcript = this.init.transcript?.() ?? this.messages;
    // answerAllCalls: on the way out a run may still be winding down, with tool calls not yet answered.
    this.saved = {
      ...this.saved,
      provider: this.factory.id,
      model: this.factory.model,
      conversation: answerAllCalls(this.conversation),
      transcript,
      totals: this.totals,
    };
    await store.save(this.saved);
  }

  /** Before exiting: the pending save, and the trajectory's queued records, on disk. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await Promise.all([this.save().catch(() => {}), this.log?.flush()]);
  }

  /** Stops what's running, flushes, and closes the MCP servers the session started. */
  async close(): Promise<void> {
    this.interrupt();
    await this.flush();
    if (this.init.ownsMcp) await this.init.mcp?.close();
  }

  private get cwd(): string {
    return this.init.cwd ?? shortenHome(this.init.root);
  }

  private idle(): void {
    if (this.running) throw new Error(BUSY);
  }

  private buildSystem(): string {
    const custom = this.init.systemPrompt;
    if (typeof custom === "string") return custom;
    const base = systemPrompt({
      cwd: this.cwd,
      tools: this.specs.map((t) => t.name),
      instructions: this.init.instructions,
      skills: this.init.skills,
      memory: this.memories,
      agents: this.init.agents ?? DEFAULT_AGENTS,
      mcp: Boolean(this.init.mcp?.status().length),
    });
    return custom ? `${base}\n\n${custom.append}` : base;
  }

  /** What the model is offered: the built-in tools and the caller's, then the MCP servers' (fixed once they've started). */
  private offered(): { specs: ToolSpec[]; tools: Tool[] } {
    const mcp = this.init.mcp;
    const tools = [...builtinTools, ...(this.init.tools ?? [])];
    return mcp ? { specs: [...this.specs, ...mcp.specs], tools: [...tools, ...mcp.tools] } : { specs: this.specs, tools };
  }

  /** Reads the model list in the background: the context window, prices, and whether reasoning can be turned off. */
  private lookup(): void {
    const factory = this.factory;
    const ticket = ++this.lookups;
    factory.lookup?.().then(
      (info) => {
        if (ticket !== this.lookups || !info) return; // the provider changed meanwhile
        this.info = info;
        // Remade once the list says whether this model's reasoning can be turned off (/think on OpenRouter).
        if (info.reasoning) this.provider = factory.make(undefined, { reasoning: info.reasoning });
        this.init.onChange?.();
      },
      () => {}, // offline: no context size or price estimates, that's all
    );
  }

  /** The caller's approver, with the session's "don't ask again" scopes, answered "no" once the run is stopped. */
  private approver(signal: AbortSignal): ((request: ApprovalRequest) => Promise<Decision>) | undefined {
    const ask = this.init.approve;
    if (!ask) return undefined;
    return async (request) => {
      if (this.always.has(request.scope.key)) return "yes";
      if (signal.aborted) return "no";
      const decision = await Promise.race([ask(request), stopped(signal).then((): Decision => "no")]);
      if (decision === "always") this.always.add(request.scope.key);
      return decision;
    };
  }

  /** Adds a request's tokens and cost to the totals (the main agent's, subagents', summaries'). */
  private count(usage: Usage): void {
    const local = Boolean(this.factory.local);
    this.totals = { ...addUsage(this.totals, usage, this.info), local: (this.totals.requests === 0 || Boolean(this.totals.local)) && local };
  }

  private note(role: "user" | "assistant", text: string): void {
    this.messages.push({ id: (this.messages.at(-1)?.id ?? 0) + 1, role, text });
  }

  private nearlyFull(): boolean {
    const context = this.contextLength;
    return Boolean(context && this.last && this.last.promptTokens + this.last.completionTokens >= context * COMPACT_AT);
  }

  /** Summarizes the conversation and continues from the summary (src/compact.ts). Only what the model sees changes. */
  private async summarizeInto(focus: string | undefined, signal: AbortSignal): Promise<CompactResult> {
    if (this.conversation.length === 0) return { compacted: false, reason: "empty", error: "Nothing to compact yet." };
    const before = this.last;
    const result = await summarize({
      provider: this.provider,
      history: this.conversation,
      system: this.system,
      tools: this.offered().specs,
      signal,
      focus,
      onUsage: (usage) => this.count(usage),
    });
    if ("error" in result) return { compacted: false, reason: signal.aborted ? "stopped" : "failed", error: result.error };
    this.conversation = compactedHistory(result.summary);
    // From here the model sees the summary, not the turns before it: the trajectory needs it to say what the model saw.
    this.trajectory()?.write({ type: "compact", ...(this.lastTurn ? { turn: this.lastTurn.id } : {}), summary: result.summary });
    this.last = undefined;
    return { compacted: true, summary: result.summary, ...(before ? { tokensBefore: before.promptTokens + before.completionTokens } : {}) };
  }

  /** This session's trajectory log, or null when logging is off. */
  private trajectory(): Trajectory | null {
    const store = this.init.trajectories;
    if (!store || !this.logging) return null;
    if (this.log?.session !== this.saved.id) {
      this.log = store.open(this.init.root, this.saved.id);
      this.log.onError = (text) => this.init.onWarning?.(text);
    }
    return this.log;
  }

  /** The session's setup (once per file), what this message says about the last turn, and the new turn. */
  private startTurnLog(log: Trajectory | null, turn: string, text: string, forModel: string, specs: ToolSpec[]): void {
    if (log) {
      if (this.sessionLogged !== log.session) {
        log.write({
          type: "session",
          root: this.init.root,
          marv: this.init.version ?? "",
          provider: this.factory.id,
          model: this.factory.model,
          system: this.system,
          tools: specs.map((t) => t.name),
          git: gitHead(this.init.root),
        });
        this.sessionLogged = log.session;
      }
      const previous = this.lastTurn;
      const signal = forModel === text ? classifyReply(text) : null; // a /skill's arguments aren't a reply
      if (previous?.session === log.session && signal) {
        log.write({ type: "feedback", turn: previous.id, score: signal.score, source: "implicit", phrase: signal.phrase });
      }
      log.write({
        type: "turn_start",
        turn,
        text,
        ...(forModel !== text ? { forModel } : {}),
        provider: this.factory.id,
        model: this.factory.model,
        yolo: this.yolo,
        sandbox: this.sandbox,
      });
    }
    // Only a logged turn can be rated: feedback for a turn the file never recorded would be an orphan.
    this.lastTurn = log ? { id: turn, session: log.session } : null;
  }

  private scheduleSave(): void {
    if (!this.init.sessions) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch(() => {});
    }, SAVE_DELAY_MS);
  }

  /** The stream send() returns: the turn's work feeds a queue, the client reads it. */
  private async *turn(text: string, forModel: string, stop: AbortController, signal?: AbortSignal): AsyncGenerator<SessionEvent> {
    const queue = new EventQueue<SessionEvent>();
    const onAbort = () => stop.abort();
    if (signal?.aborted) stop.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const work = this.runTurn(text, forModel, stop, (event) => queue.push(event)).finally(() => queue.close());
    try {
      yield* queue;
    } finally {
      // The client left before the end (break, or it threw): that's an interrupt. A no-op after a normal end.
      stop.abort();
      // Wait for the loop's cleanup: every tool call answered before the history is used again.
      await work;
      signal?.removeEventListener("abort", onAbort);
      this.current = null;
      this.running = false;
      this.scheduleSave();
    }
  }

  /** One turn's work. Never rejects: whatever happens ends in turn_end. */
  private async runTurn(text: string, forModel: string, stop: AbortController, emit: (event: SessionEvent) => void): Promise<void> {
    const turn = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    emit({ type: "turn_start", turn });
    let reason: TurnEndReason = "error";
    let main: AgentRecorder | undefined;
    // Subagents' recorders, by call id; ids are unique within the turn.
    const subRecorders = new Map<string, AgentRecorder>();
    try {
      await this.reloading; // clear() may still be reading memory for the new system prompt
      // MCP servers still starting: their tools must be in place before the first request (the list can't change
      // after it, or the prompt cache would start over). Interrupting the wait ends the turn.
      const mcp = this.init.mcp;
      if (mcp && !mcp.settled) {
        emit({ type: "status", status: "waiting_for_mcp" });
        // A failed start still settles: the turn goes on with whatever tools there are.
        const ready = mcp.ready.then(
          () => "ready" as const,
          () => "ready" as const,
        );
        if ((await Promise.race([ready, stopped(stop.signal).then(() => "stopped" as const)])) === "stopped") {
          reason = "interrupted";
          return;
        }
      }
      // What this turn runs with: settings changed while it runs apply from the next one.
      const { specs, tools } = this.offered();
      const { sandbox, yolo } = this;
      const log = this.trajectory();
      const record = (r: TrajectoryRecord) => log?.write(r);
      this.startTurnLog(log, turn, text, forModel, specs);
      main = new AgentRecorder(record, { turn, agent: "main" });

      // Nearly out of context: summarize first, so this message (and what follows) fits.
      if (this.nearlyFull()) {
        emit({ type: "status", status: "compacting" });
        const result = await this.summarizeInto(undefined, stop.signal);
        emit({ type: "compaction", result });
        if (!result.compacted && result.reason === "stopped") {
          // Stopping meant "stop": the message too (it would run on the nearly full context).
          main.finish("aborted");
          reason = "interrupted";
          return;
        }
      }
      this.conversation.push({ role: "user", text: forModel });
      this.note("user", text);
      emit({ type: "status", status: "running" });

      const provider = this.provider;
      const approve = this.approver(stop.signal);
      let subagents = 0;
      // What the agent tool needs to start subagents. Only the main agent gets one; what a subagent does reaches
      // this conversation only as its tool result, and the client through "subagent" events.
      const agentHost: AgentHost = {
        agents: this.init.agents ?? DEFAULT_AGENTS,
        cwd: this.cwd,
        instructions: this.init.instructions,
        worktreesDir: this.init.worktreesDir,
        providerFor: (model) => (model ? this.factory.make(model) : provider),
        onUsage: (usage) => this.count(usage),
        onProgress: (callId, progress) => emit({ type: "subagent_progress", callId, progress }),
        onEvent: (callId, event) => {
          subRecorders.get(callId)?.event(event);
          emit({ type: "subagent", callId, event });
        },
      };

      for await (const event of runAgent({
        provider,
        history: this.conversation,
        system: this.system,
        tools: specs,
        runTool: (call) =>
          runTool(
            call,
            { root: this.init.root, signal: stop.signal, approve, sandbox, yolo, skills: this.init.skills, memory: this.init.memory?.paths, agentHost },
            tools,
          ),
        signal: stop.signal,
        isParallel: isParallelCall,
        // At the step limit, ask instead of stopping dead; with no one to ask, it stops there.
        onLimit: approve && (async (steps) => (await approve(stepLimitRequest(steps))) !== "no"),
      })) {
        main.event(event);
        switch (event.type) {
          case "usage":
            this.last = event.usage;
            this.count(event.usage);
            break;
          case "assistant":
            this.note("assistant", event.text);
            break;
          case "tool_start":
            if (event.call.name === "agent") {
              const args = agentArgs(event.call.arguments);
              const subagent = `${turn}.${++subagents}`;
              record({
                type: "subagent_start",
                turn,
                agent: "main",
                subagent,
                call: event.call.id,
                agentType: args.type,
                description: args.description,
                prompt: args.prompt,
                isolation: args.isolation,
              });
              subRecorders.set(event.call.id, new AgentRecorder(record, { turn, agent: subagent }));
            }
            break;
          case "tool_end":
            // A subagent that failed before its loop started never sent done.
            subRecorders.get(event.call.id)?.finish(event.result.isError ? "error" : "end");
            subRecorders.delete(event.call.id);
            break;
          case "done":
            reason = event.reason;
            break;
        }
        emit(event);
      }
    } catch (err) {
      // A provider (or a tool's own code) that throws instead of reporting an error: the turn ends, the session lives on.
      emit({ type: "error", message: `Error: ${err instanceof Error ? err.message : String(err)}` });
      reason = "error";
    } finally {
      for (const sub of subRecorders.values()) sub.finish("interrupted");
      main?.finish("error"); // only if the loop threw: otherwise its done already ended the turn
      // Stop anything still running (a no-op after a normal end): subagents still running in a parallel group
      // would otherwise carry on unseen, and could still ask for approvals.
      stop.abort();
      emit({ type: "turn_end", turn, reason });
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test tests/session && bun run typecheck`
Expected: the 10 tests in "a turn" pass; typecheck clean. If `yield* queue` fails to typecheck, write the loop out: `for await (const event of queue) yield event;`.

- [ ] **Step 5: Commit**

```bash
git add src/session.ts tests/session.test.ts
git commit -m "MarvSession: Marv's turn logic, without a UI

Everything App.send() did besides drawing (waiting for MCP, compaction,
subagents, trajectories, saving, the step-limit question) now lives in a
class whose send() streams events. Every turn starts with turn_start and
ends with exactly one turn_end; leaving the loop early interrupts it, and
every tool call still gets a result. The App doesn't use it yet."
```

---

### Task 8: Pin the session's approvals and step limit

These pass against Task 7's code (they describe ported behavior plus the "no approver" default from Task 3). If one fails, fix `src/session.ts`, not the test.

**Files:**
- Modify: `tests/session.test.ts` (append)

- [ ] **Step 1: Add the tests**

Append to `tests/session.test.ts`:

```ts
describe("approvals", () => {
  test("without an approver, a yolo-safe edit runs, anything else is refused, and the turn goes on", async () => {
    const provider = new ScriptedProvider([
      useTools(call("c1", "write_file", { path: "a.txt", content: "hi\n" }), call("c2", "bash", { command: "curl example.com", network: true })),
      say("Done."),
    ]);
    const events = await collect(makeSession(provider).send("go"));
    expect(await readFile(join(project, "a.txt"), "utf8")).toBe("hi\n");
    const refused = events.find((e) => e.type === "tool_end" && e.call.id === "c2");
    expect(refused).toMatchObject({ result: { isError: true, output: expect.stringContaining("no one to ask") } });
    expect(events).toContainEqual({ type: "done", reason: "end" });
  });

  test("'always' covers that scope for the rest of the session, later turns included", async () => {
    const asked: string[] = [];
    const provider = new ScriptedProvider([
      useTools(call("c1", "write_file", { path: "a.txt", content: "1" })),
      say("One."),
      useTools(call("c2", "write_file", { path: "b.txt", content: "2" })),
      say("Two."),
    ]);
    const session = makeSession(provider, { yolo: false, approve: async (r) => (asked.push(r.label), "always") });
    await collect(session.send("one"));
    await collect(session.send("two"));
    expect(asked).toEqual(["a.txt"]);
    expect(existsSync(join(project, "b.txt"))).toBe(true);
  });

  test("stopping the turn answers a pending approval with no", async () => {
    const provider = new ScriptedProvider([useTools(call("c1", "write_file", { path: "a.txt", content: "1" }))]);
    let session: MarvSession | undefined;
    session = makeSession(provider, {
      yolo: false,
      approve: () => {
        session!.interrupt();
        return new Promise<Decision>(() => {}); // never answers: only the stop can
      },
    });
    const events = await collect(session.send("go"));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", result: expect.objectContaining({ declined: true, summary: "interrupted" }) }));
    expect(existsSync(join(project, "a.txt"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
  });

  test("without an approver it stops at the step limit", async () => {
    const provider = new ScriptedProvider(Array.from({ length: 30 }, (_, i) => useTools(read(`c${i}`))));
    const events = await collect(makeSession(provider).send("loop"));
    expect(provider.requests).toHaveLength(25);
    expect(events).toContainEqual({ type: "done", reason: "max_steps" });
  });

  test("with an approver it asks at the step limit, in the continue scope", async () => {
    const provider = new ScriptedProvider(Array.from({ length: 30 }, (_, i) => useTools(read(`c${i}`))));
    const asked: ApprovalRequest[] = [];
    const events = await collect(makeSession(provider, { approve: async (r) => (asked.push(r), "no") }).send("loop"));
    expect(asked.map((r) => r.scope.key)).toEqual(["continue"]);
    expect(events).toContainEqual({ type: "step_limit", steps: 25, continued: false });
  });
});
```

- [ ] **Step 2: Run them**

Run: `bun test tests/session`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/session.test.ts
git commit -m "Session tests: approvals and the step limit

No approver: yolo-safe calls run and the rest are refused without stopping
the turn. 'Always' lasts the session. A stop answers a pending approval.
The step limit asks in the continue scope, or stops with no one to ask."
```

---

### Task 9: Pin MCP waiting and compaction

**Files:**
- Modify: `tests/session.test.ts` (append)

- [ ] **Step 1: Add the tests**

Append to `tests/session.test.ts`:

```ts
/** Stands in for McpManager: the parts a session uses. */
function fakeMcp(ready: Promise<void>, specs: ToolSpec[] = []): McpManager {
  const mcp = { settled: false, ready, specs, tools: [], status: () => [] };
  void ready.then(() => (mcp.settled = true));
  return mcp as unknown as McpManager;
}

describe("MCP servers", () => {
  test("the first request waits for them, and offers their tools", async () => {
    let start!: () => void;
    const spec: ToolSpec = { name: "mcp__x__ping", description: "[x] ping", parameters: { type: "object" } };
    const provider = new ScriptedProvider([say("Pong.")]);
    const session = makeSession(provider, { mcp: fakeMcp(new Promise<void>((resolve) => (start = resolve)), [spec]) });
    for await (const event of session.send("ping")) {
      if (event.type === "status" && event.status === "waiting_for_mcp") {
        expect(provider.requests).toHaveLength(0);
        start();
      }
    }
    expect(provider.requests[0]!.options.tools).toContainEqual(spec);
  });

  test("interrupting the wait ends the turn before anything is sent", async () => {
    const provider = new ScriptedProvider([say("never")]);
    const session = makeSession(provider, { mcp: fakeMcp(new Promise<void>(() => {})) });
    const events: SessionEvent[] = [];
    for await (const event of session.send("ping")) {
      events.push(event);
      if (event.type === "status") session.interrupt();
    }
    expect(types(events)).toEqual(["turn_start", "status", "turn_end"]);
    expect(events.at(-1)).toMatchObject({ reason: "interrupted" });
    expect(provider.requests).toHaveLength(0);
  });
});

describe("compaction", () => {
  const used = (promptTokens: number): AgentEvent => ({ type: "usage", usage: { promptTokens, completionTokens: 0 } });

  test("a nearly full context is summarized before the next message", async () => {
    const provider = new ScriptedProvider([[used(900), ...say("First answer.")], say("SUMMARY of it all"), say("Second answer.")], 1000);
    const session = makeSession(provider);
    await collect(session.send("first"));
    const events = await collect(session.send("second"));
    expect(events).toContainEqual({ type: "status", status: "compacting" });
    expect(events).toContainEqual({ type: "compaction", result: { compacted: true, summary: "SUMMARY of it all", tokensBefore: 900 } });
    const after = provider.requests[2]!.history;
    expect(after[0]!.text).toContain("SUMMARY of it all");
    expect(after.at(-1)).toEqual({ role: "user", text: "second" });
  });

  test("stopping the compaction stops the turn, and the message isn't sent", async () => {
    const first = new ScriptedProvider([[used(900), ...say("First answer.")]]);
    const hanging = new Hanging();
    let requests = 0;
    const provider: Provider = {
      name: "first, then hanging",
      contextLength: 1000,
      stream: (history, options) => (++requests === 1 ? first.stream(history, options) : hanging.stream(history, options)),
    };
    const session = makeSession(provider);
    await collect(session.send("first"));
    const events: SessionEvent[] = [];
    for await (const event of session.send("second")) {
      events.push(event);
      if (event.type === "status" && event.status === "compacting") session.interrupt();
    }
    expect(events).toContainEqual({ type: "compaction", result: { compacted: false, reason: "stopped", error: "Stopped." } });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "interrupted" });
    expect(requests).toBe(2); // the first answer and the summary: "second" was never sent
  });

  test("compact(): nothing to do on an empty conversation; afterwards the next request starts from the summary", async () => {
    const provider = new ScriptedProvider([say("Answer."), say("THE SUMMARY"), say("Next.")]);
    const session = makeSession(provider);
    expect(await session.compact()).toEqual({ compacted: false, reason: "empty", error: "Nothing to compact yet." });
    await collect(session.send("first"));
    expect(await session.compact("the plan")).toMatchObject({ compacted: true, summary: "THE SUMMARY" });
    expect(provider.requests[1]!.history.at(-1)!.text).toContain("Focus especially on: the plan");
    await collect(session.send("next"));
    expect(provider.requests[2]!.history[0]!.text).toContain("THE SUMMARY");
  });
});
```

- [ ] **Step 2: Run them**

Run: `bun test tests/session`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/session.test.ts
git commit -m "Session tests: waiting for MCP servers, and compaction

The first request waits for MCP tools (interrupting ends the turn with
nothing sent); a nearly full context is summarized first, and stopping that
summary means the message isn't sent either."
```

---

### Task 10: Pin subagents and trajectories

**Files:**
- Modify: `tests/session.test.ts` (append)

- [ ] **Step 1: Add the tests**

Append to `tests/session.test.ts`:

```ts
/** A parent that starts one subagent ("look around"), and the subagent, which finds the notes. */
const withSubagent = () =>
  new RoutedProvider({
    "parent-task": new ScriptedProvider([useTools(call("a1", "agent", { description: "look around", prompt: "sub-task: find the notes" })), say("Parent done.")]),
    "sub-task": new ScriptedProvider([say("Found them.")]),
  });

describe("subagents", () => {
  test("their events arrive in the same stream, tagged with the call that started them", async () => {
    const events = await collect(makeSession(withSubagent()).send("parent-task: go"));
    const start = events.findIndex((e) => e.type === "tool_start" && e.call.id === "a1");
    const end = events.findIndex((e) => e.type === "tool_end" && e.call.id === "a1");
    const sub = events.flatMap((e, i) => (e.type === "subagent" ? [{ i, e }] : []));
    expect(sub.length).toBeGreaterThan(0);
    expect(sub.every(({ e }) => e.callId === "a1")).toBe(true);
    expect(sub.some(({ e }) => e.event.type === "assistant" && e.event.text === "Found them.")).toBe(true);
    expect(sub.every(({ i }) => i > start && i < end)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ type: "subagent_progress", callId: "a1" }));
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "end" });
  });
});

describe("trajectories", () => {
  async function records(store: TrajectoryStore, session: MarvSession) {
    await session.flush();
    const text = await readFile(store.open(project, session.id).path, "utf8");
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });
  }

  test("a turn is recorded, and the next message's tone rates it", async () => {
    const store = new TrajectoryStore(dir);
    const session = makeSession(new ScriptedProvider([say("Done."), say("Glad to help.")]), { trajectories: store, version: "9.9.9" });
    await collect(session.send("fix it"));
    await collect(session.send("thanks, perfect"));
    const log = await records(store, session);
    expect(log.map((r) => r.type)).toEqual(["session", "turn_start", "assistant", "agent_end", "feedback", "turn_start", "assistant", "agent_end"]);
    expect(log[0]).toMatchObject({ marv: "9.9.9", provider: "test", model: "test-model" });
    expect(log[4]).toMatchObject({ source: "implicit", score: 1, turn: log[1]!.turn });
  });

  test("rate() rates the last turn, and says why when it can't", async () => {
    const store = new TrajectoryStore(dir);
    const session = makeSession(new ScriptedProvider([say("Done.")]), { trajectories: store });
    expect(session.rate({ score: 1 })).toBe("nothing");
    await collect(session.send("fix it"));
    expect(session.rate({ score: -1, note: "wrong file" })).toBe("rated");
    expect((await records(store, session)).at(-1)).toMatchObject({ type: "feedback", source: "explicit", score: -1, note: "wrong file" });
    session.configure({ trajectories: false });
    expect(session.rate({ score: 1 })).toBe("off");
    expect(makeSession(new ScriptedProvider([])).rate({ score: 1 })).toBe("off");
  });

  test("a subagent's steps are recorded under its own agent id", async () => {
    const store = new TrajectoryStore(dir);
    const session = makeSession(withSubagent(), { trajectories: store });
    await collect(session.send("parent-task: go"));
    const log = await records(store, session);
    const start = log.find((r) => r.type === "subagent_start");
    expect(start).toMatchObject({ agent: "main", call: "a1", description: "look around" });
    expect(log).toContainEqual(expect.objectContaining({ type: "assistant", agent: start!.subagent, text: "Found them." }));
    expect(log).toContainEqual(expect.objectContaining({ type: "agent_end", agent: start!.subagent }));
  });
});
```

- [ ] **Step 2: Run them**

Run: `bun test tests/session`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/session.test.ts
git commit -m "Session tests: subagents and trajectories

A subagent's events come through the same stream, between its tool_start
and tool_end; turns, implicit and explicit ratings, and subagents' steps
land in the trajectory as the App wrote them."
```

---

### Task 11: Pin saving, resuming, clear, configure, model info, and the prompt cache

**Files:**
- Modify: `tests/session.test.ts` (append)

- [ ] **Step 1: Add the tests**

Append to `tests/session.test.ts`:

```ts
describe("saving and resuming", () => {
  test("a turn is saved, and another session object can resume it", async () => {
    const sessions = new SessionStore(dir);
    const a = makeSession(new ScriptedProvider([say("Noted.")]), { sessions });
    await collect(a.send("remember 42"));
    await a.flush();
    const provider = new ScriptedProvider([say("42.")]);
    const b = makeSession(provider, { sessions });
    const resumed = await b.resume("latest");
    expect(resumed).toMatchObject({
      id: a.id,
      model: "test-model",
      transcript: [
        { role: "user", text: "remember 42" },
        { role: "assistant", text: "Noted." },
      ],
    });
    expect(b.id).toBe(a.id);
    await collect(b.send("what was it?"));
    expect(provider.requests[0]!.history.map((t) => t.text)).toEqual(["remember 42", "Noted.", "what was it?"]);
  });

  test("the client's transcript is what's saved", async () => {
    const sessions = new SessionStore(dir);
    const transcript = [
      { id: 7, role: "user" as const, text: "hi" },
      { id: 8, role: "system" as const, text: "a notice" },
    ];
    const session = makeSession(new ScriptedProvider([say("Hello.")]), { sessions, transcript: () => transcript });
    await collect(session.send("hi"));
    await session.flush();
    expect((await sessions.load(project, session.id))?.transcript).toEqual(transcript);
  });

  test("a session file saved by the current version loads", async () => {
    const sessions = new SessionStore(dir);
    const saved: SavedSession = {
      version: 1,
      id: "2026-10-05T10-00-00-000Z-abc123",
      root: project,
      createdAt: 1,
      updatedAt: 2,
      provider: "ollama",
      model: "qwen3.5:9b",
      conversation: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "Hello." },
      ],
      transcript: [
        { id: 1, role: "user", text: "hi" },
        { id: 2, role: "tool", text: "read_file", tool: { label: "a.ts", status: "done" } },
        { id: 3, role: "assistant", text: "Hello." },
      ],
      totals: { requests: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 2 },
    };
    await sessions.save(saved);
    const resumed = await makeSession(new ScriptedProvider([]), { sessions }).resume(saved.id);
    expect(resumed).toMatchObject({ id: saved.id, transcript: saved.transcript, totals: saved.totals });
  });

  test("without a store, or for an unknown id, there's nothing to resume", async () => {
    expect(await makeSession(new ScriptedProvider([])).resume("latest")).toBeNull();
    expect(await makeSession(new ScriptedProvider([]), { sessions: new SessionStore(dir) }).resume("nope")).toBeNull();
  });
});

describe("between turns", () => {
  test("clear(), resume() and compact() refuse during a turn; configure() applies from the next one", async () => {
    const hanging = new Hanging();
    const other = new ScriptedProvider([say("From the other model.")]);
    const session = makeSession(hanging, { sessions: new SessionStore(dir) });
    for await (const event of session.send("go")) {
      if (event.type !== "text_delta") continue;
      expect(() => session.clear()).toThrow(/working/);
      await expect(session.resume("latest")).rejects.toThrow(/working/);
      await expect(session.compact()).rejects.toThrow(/working/);
      session.configure({ provider: fixed(other) });
      session.interrupt();
    }
    expect(hanging.requests).toBe(1);
    await collect(session.send("again"));
    expect(other.requests).toHaveLength(1);
  });

  test("clear() starts a new conversation, with a new id and the memories saved meanwhile", async () => {
    const paths = memoryPaths(dir, project);
    const provider = new ScriptedProvider([say("One."), say("Two.")]);
    const session = makeSession(provider, { memory: { paths, initial: await loadMemory(paths) } });
    await collect(session.send("one"));
    const before = session.id;
    await addMemory(paths.personal, "The user likes tabs");
    await session.clear();
    expect(session.id).not.toBe(before);
    await collect(session.send("two"));
    expect(provider.requests[1]!.history).toEqual([{ role: "user", text: "two" }]);
    expect(provider.requests[0]!.options.system).not.toContain("The user likes tabs");
    expect(provider.requests[1]!.options.system).toContain("The user likes tabs");
  });

  test("the model's info arrives in the background: its context window, and a provider remade for its reasoning", async () => {
    const provider = new ScriptedProvider([]);
    const made: unknown[] = [];
    let changed = 0;
    const factory: ProviderFactory = {
      id: "openrouter",
      model: "x/y",
      make: (_model, info) => (made.push(info), provider),
      lookup: async () => ({ id: "x/y", context: 200_000, reasoning: "optional" }),
    };
    const session = makeSession(factory, { onChange: () => changed++ });
    await Bun.sleep(0);
    expect(session.contextLength).toBe(200_000);
    expect(session.modelInfo?.reasoning).toBe("optional");
    expect(made).toEqual([undefined, { reasoning: "optional" }]);
    expect(changed).toBe(1);
  });

  test("every request extends the previous one exactly, across turns and settings changes (prompt cache)", async () => {
    const provider = new ScriptedProvider([useTools(read("c1")), say("One."), useTools(read("c2")), say("Two."), say("Three.")]);
    const session = makeSession(provider);
    await collect(session.send("one"));
    session.configure({ yolo: false, sandbox: false });
    await collect(session.send("two"));
    await collect(session.send("three"));
    expect(provider.requests).toHaveLength(5);
    for (let i = 1; i < provider.requests.length; i++) {
      const before = provider.requests[i - 1]!;
      const after = provider.requests[i]!;
      expect(after.history.slice(0, before.history.length)).toEqual(before.history); // only appended to
      expect(after.history.length).toBeGreaterThan(before.history.length);
      expect(after.options.system).toBe(before.options.system); // the same system prompt
      expect(after.options.tools).toBe(before.options.tools); // the very same tool definitions
    }
  });
});
```

- [ ] **Step 2: Run them**

Run: `bun test tests/session && bun run typecheck`
Expected: all pass; clean.

- [ ] **Step 3: Commit**

```bash
git add tests/session.test.ts
git commit -m "Session tests: saving, resuming, clear, configure, the cache

Another session object resumes a saved one; the client's transcript is what's
saved; files saved today still load. clear/resume/compact refuse mid-turn
while configure applies from the next turn. Across turns and settings changes
every request still extends the last one exactly."
```

---

### Task 12: The App runs on the Session

`App` keeps its props (so every existing test runs unchanged) and makes a `MarvSession` from them once. Its `send()` shrinks to drawing the session's events. This is the step the 640 existing tests are for.

**Files:**
- Modify: `src/app.tsx`

- [ ] **Step 1: Replace the imports**

Replace everything from the first line of `src/app.tsx` down to (not including) `const EXIT_CONFIRM_MS = 1500;` with:

```tsx
import { join } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput, useWindowSize, type DOMElement } from "ink";
import { agentArgs } from "./agent.ts";
import { applyEvent, createAgentLog, type AgentLog } from "./agent-log.ts";
import { GENERAL_PURPOSE, type AgentType } from "./agents.ts";
import { copyToClipboard } from "./clipboard.ts";
import { commands, isCommand, runCommand, trajectoriesStatus, yoloStatus } from "./commands/index.ts";
import {
  needsSetup,
  PRESETS,
  resolveConfig,
  type Config,
  type ConfigStore,
  type Env,
  type FileConfig,
  type ProviderId,
} from "./config/config.ts";
import { projectKey, shortenHome } from "./paths.ts";
import { mouse, type MouseEvent } from "./mouse.ts";
import { configFactory } from "./provider/factory.ts";
import { createProvider } from "./provider/index.ts";
import { listModels, type ModelInfo } from "./provider/models.ts";
import type { Provider, Usage } from "./provider/types.ts";
import { selection } from "./selection.ts";
import { costText, emptyTotals, tokens, type Totals } from "./usage.ts";
import { addMemory, findMemory, loadMemory, removeMemory, type Memories, type MemoryPaths } from "./memory.ts";
import { MarvSession, type CompactResult, type Resumed } from "./session.ts";
import { timeAgo, type SessionStore, type SessionSummary } from "./sessions.ts";
import { skillMessage, type Skill } from "./skills.ts";
import type { TrajectoryStore } from "./trajectory.ts";
import type { McpManager, McpServerStatus } from "./mcp/manager.ts";
import type { AgentProgress, ApprovalRequest, Decision } from "./tools/types.ts";
import type { CommandAction } from "./commands/index.ts";
import type { Message } from "./types.ts";
import { AgentView, AgentViewHeader } from "./ui/AgentView.tsx";
import { Approval } from "./ui/Approval.tsx";
import { SessionPicker } from "./ui/SessionPicker.tsx";
import { MessageView } from "./ui/MessageView.tsx";
import { PromptInput } from "./ui/PromptInput.tsx";
import { ScrollView } from "./ui/ScrollView.tsx";
import { Setup } from "./ui/Setup.tsx";
import { Splash } from "./ui/Splash.tsx";
import { formatUsage, StatusBar } from "./ui/StatusBar.tsx";
import { ThinkingView } from "./ui/ThinkingView.tsx";
import { agentEntryAt, Transcript, type TranscriptItem } from "./ui/Transcript.tsx";

```

- [ ] **Step 2: Delete `gitHead`**

Delete the `gitHead` function and its doc comment ("The project's commit, so a trajectory says what code a run started from."); it lives in `src/session.ts` now. (`agentArgs` already moved in Task 6; `describeUntrusted`, `DEFAULT_AGENTS` and `NO_PROBLEMS` stay.)

- [ ] **Step 3: Replace the component's state and `send()`**

In `App`, replace everything from `  const { exit } = useApp();` through the end of the `send` `useCallback` (its closing `  );`, just before `  // /memory, /remember, /forget: you editing Marv's memory directly`) with:

```tsx
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [phase, setPhase] = useState<"splash" | "main">(splashMs > 0 ? "splash" : "main");

  // Config: the saved file + env overrides → the Config we run with (the session makes the Provider from it).
  const [file, setFile] = useState(initialFile);
  const config = useMemo(() => resolveConfig(file, env), [file, env]);
  const [setupMode, setSetupMode] = useState<SetupMode>(() => (needsSetup(initialFile, config) ? "first-run" : null));

  // What the user sees (includes help text, errors, the welcome banner). What the model sees is the session's
  // conversation (src/session.ts): Marv's own notices never reach it.
  const [items, setItems] = useState<TranscriptItem[]>([{ kind: "welcome", id: "welcome-0" }]);
  // Read when the session saves, which can be after unmounting (on the way out).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const configRef = useRef(config);
  configRef.current = config;
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);
  // marv -c: the last session is still loading.
  const [loadingSession, setLoadingSession] = useState(false);

  // Memory as of the start of this conversation, for the welcome banner (the session reloads it on /clear).
  const [memories, setMemories] = useState<Memories | undefined>(memory?.initial);
  // Skills show up in the / menu next to the built-in commands.
  const menu = useMemo(() => [...commands, ...skills.map(({ name, description }) => ({ name, description }))], [skills]);
  // The session's numbers, for the status bar: the latest request's tokens (how full the context is), and the
  // whole session's (they survive /clear: that's money spent).
  const [usage, setUsage] = useState<Usage | null>(null);
  const [totals, setTotals] = useState<Totals>(emptyTotals);
  const [compacting, setCompacting] = useState(false);
  // What a turn is waiting for before its first request (MCP servers starting), shown in place of "Thinking…".
  const [waitingFor, setWaitingFor] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  // Tools running right now (subagents run several at once), and how many of
  // them are subagents. While any run, their transcript lines show the
  // progress, so no "Thinking…".
  const [toolsRunning, setToolsRunning] = useState(0);
  const [agentsRunning, setAgentsRunning] = useState(0);
  // ctrl+o: show subagents' steps under their entries.
  const [showSteps, setShowSteps] = useState(false);
  // Each subagent's own transcript, by its entry's id (`msg-12`), for the view
  // a click on the entry opens. Only this session's runs: sessions don't save them.
  const agentLogs = useRef(new Map<string, AgentLog>());
  // The subagent whose view is open, if any; `logVersion` moves when its log changed.
  const [viewing, setViewing] = useState<string | null>(null);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const [logVersion, setLogVersion] = useState(0);
  // Where each subagent entry is drawn, for hit-testing clicks (see Transcript).
  const agentEntries = useRef(new Map<string, DOMElement>());
  const onAgentRef = useCallback((id: string, element: DOMElement | null) => {
    if (element) agentEntries.current.set(id, element);
    else agentEntries.current.delete(id);
  }, []);
  const openView = useCallback((id: string | null) => {
    // The two transcripts have different rows: a selection or remembered row of one means nothing in the other.
    selection.reset();
    setViewing(id);
  }, []);
  // Tools waiting for the user's yes/no, oldest first (parallel subagents can
  // ask at the same time). The first one is shown in place of the prompt.
  type Pending = { id: number; request: ApprovalRequest; resolve: (d: Decision) => void };
  const nextApprovalId = useRef(1);
  const approvals = useRef<Pending[]>([]);
  const [approval, setApproval] = useState<{ head: Pending; waiting: number } | null>(null);
  const showApprovals = useCallback(() => {
    const [head] = approvals.current;
    setApproval(head ? { head, waiting: approvals.current.length - 1 } : null);
  }, []);

  // The session asks here for each call that needs a yes. "Don't ask again" scopes are the session's: it answers
  // those itself, so they never reach this queue.
  const approve = useCallback(
    (request: ApprovalRequest): Promise<Decision> =>
      new Promise((resolve) => {
        approvals.current.push({ id: nextApprovalId.current++, request, resolve });
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
        // The session remembers the scope from now on; requests already waiting in it are covered too.
        const key = head.request.scope.key;
        for (const pending of rest) if (pending.request.scope.key === key) pending.resolve("yes");
        remaining = rest.filter((pending) => pending.request.scope.key !== key);
      }
      approvals.current = remaining;
      showApprovals();
      head.resolve(decision);
    },
    [showApprovals],
  );
  /** No to everything waiting (ctrl+c at an approval, and part of Esc). */
  const declineAll = useCallback(() => {
    const pending = approvals.current;
    approvals.current = [];
    showApprovals();
    for (const p of pending) p.resolve("no");
  }, [showApprovals]);
  // Esc at an approval: decline everything and stop the run, like ctrl+c, so
  // parallel subagents that are still running don't raise new prompts.
  const cancelAll = useCallback(() => {
    declineAll();
    abortRef.current?.abort();
  }, [declineAll]);
  // The model's reasoning while it thinks. Shown live, never sent back to the model.
  const [thinking, setThinking] = useState("");
  const [confirmExit, setConfirmExit] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Set while the session works (a turn, or /compact): Esc and ctrl+c stop it through this.
  const abortRef = useRef<{ abort(): void } | null>(null);
  const nextId = useRef(1);
  // Bumped on every submit so the transcript jumps back to the newest message.
  const [followKey, setFollowKey] = useState(0);

  const busy = streaming !== null;

  const addMessage = useCallback((message: Omit<Message, "id">) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { kind: "message", id: `msg-${id}`, message: { id, ...message } }]);
    return id;
  }, []);

  const updateMessage = useCallback((id: number, patch: Partial<Message>) => {
    setItems((prev) =>
      prev.map((item) => (item.kind === "message" && item.message.id === id ? { ...item, message: { ...item.message, ...patch } } : item)),
    );
  }, []);

  // The session: the conversation, the agent loop, tools, MCP, compaction, trajectories and saving
  // (src/session.ts). Made once from the props; changed settings reach it through configure() below.
  const [, setSessionVersion] = useState(0);
  const [session] = useState(
    () =>
      new MarvSession({
        root,
        cwd,
        provider: configFactory(config, makeProvider, loadModels),
        version,
        instructions,
        skills,
        agents,
        memory,
        mcp,
        approve,
        sandbox: config.sandbox,
        yolo: config.yolo,
        sessions,
        trajectories,
        logTrajectories: config.trajectories,
        worktreesDir,
        transcript: () => itemsRef.current.flatMap((item) => (item.kind === "message" ? [item.message] : [])),
        onChange: () => setSessionVersion((v) => v + 1),
        onWarning: (text) => addMessage({ role: "system", text, isError: true }),
      }),
  );
  // Settings changed (setup, /model, /think, /sandbox, /yolo, /trajectories): the session uses them from its next turn.
  const configured = useRef(config);
  useEffect(() => {
    if (configured.current === config) return;
    configured.current = config;
    session.configure({
      provider: configFactory(config, makeProvider, loadModels),
      sandbox: config.sandbox,
      yolo: config.yolo,
      trajectories: config.trajectories,
    });
    setSessionVersion((v) => v + 1);
  }, [config, session, makeProvider, loadModels]);
  // What the model list said about the model (OpenRouter), and its context window.
  const info = session.modelInfo;
  const contextLength = session.contextLength;

  /** The status bar's numbers, from the session. */
  const syncUsage = useCallback(() => {
    const { last, totals } = session.usage();
    setUsage(last ?? null);
    setTotals(totals);
  }, [session]);

  const clearTranscript = useCallback(() => {
    selection.reset();
    agentLogs.current.clear();
    setViewing(null);
    // A new conversation (and session file), with the memories saved during the last one.
    void session.clear().then(() => setMemories(session.memory));
    setUsage(null);
    setItems([{ kind: "welcome", id: "welcome-0" }]);
  }, [session]);

  /** Says how a compaction went (automatic: before a message, because the context was nearly full). */
  const reportCompaction = useCallback(
    (result: CompactResult, automatic: boolean) => {
      if (!result.compacted) {
        if (result.reason === "empty") addMessage({ role: "system", text: "Nothing to compact yet." });
        // Stopped before a message: that's the message too (it would run on the nearly full context).
        else if (result.reason === "stopped")
          addMessage({ role: "system", text: automatic ? "Stopped: nothing was compacted, and your message wasn't sent." : "Compaction stopped; nothing changed." });
        else addMessage({ role: "system", isError: true, text: `Couldn't compact the conversation: ${result.error}` });
        return;
      }
      const usedBefore = result.tokensBefore;
      const context = session.contextLength;
      const why = automatic && usedBefore && context ? ` (the context was ${Math.round((100 * usedBefore) / context)}% full)` : "";
      const size = usedBefore ? `: ${tokens(usedBefore)} → about ${tokens(Math.round(result.summary.length / 4))} tokens` : "";
      addMessage({
        role: "system",
        text: `✻ Compacted the conversation${why}${size}. Marv continues from a summary; your transcript is unchanged.`,
      });
    },
    [session, addMessage],
  );

  /** /compact [focus]: summarizes the conversation now (src/compact.ts). The transcript is untouched; Esc cancels it. */
  const compact = useCallback(
    async (focus: string | undefined) => {
      abortRef.current = { abort: () => session.interrupt() };
      setStreaming("");
      setCompacting(true);
      let result: CompactResult;
      try {
        result = await session.compact(focus);
      } catch (err) {
        result = { compacted: false, reason: "failed", error: (err as Error).message };
      }
      abortRef.current = null;
      setStreaming(null);
      setCompacting(false);
      syncUsage();
      reportCompaction(result, false);
    },
    [session, syncUsage, reportCompaction],
  );

  const send = useCallback(
    // `forModel`: what the model gets, when it differs from what the user typed (a /skill).
    async (text: string, forModel = text) => {
      addMessage({ role: "user", text });
      // Busy from here, so a second message can't start a second turn; Esc or ctrl+c (they abort whatever
      // abortRef holds) stop this one, also while it waits for MCP servers or compacts.
      abortRef.current = { abort: () => session.interrupt() };
      setStreaming("");

      // Per step: the reply streaming in, and any reasoning before it.
      let reply = "";
      let thought = "";
      let stepStarted = Date.now();
      let thoughtMs = 0;
      const noteThought = () => {
        if (thought) {
          const seconds = Math.max(1, Math.round((thoughtMs || Date.now() - stepStarted) / 1000));
          addMessage({ role: "system", text: `✻ Thought for ${seconds}s` });
        }
        thought = "";
        thoughtMs = 0;
        setThinking("");
      };
      const toolLines = new Map<string, { line: number; label: string }>();
      // Calls that got their tool_end; any other entry is closed in `finally`.
      const ended = new Set<string>();
      // Set first thing in `finally`: a subagent still winding down after the
      // run ended mustn't schedule a flush (it would show the run as busy again).
      let over = false;
      // Subagents' progress, batched into the same flush as streamed text: with
      // several running, updating the transcript on every step would re-render
      // it far more often than Ink can draw.
      const progress = new Map<string, AgentProgress>();
      const steps = new Map<string, string[]>();
      // Subagents' logs, by call id (the view finds them by entry id); the open one re-renders in the flush.
      const logs = new Map<string, AgentLog>();
      let logChanged = false;
      const isViewed = (log: AgentLog) => viewingRef.current !== null && agentLogs.current.get(viewingRef.current) === log;
      // A compaction the user stopped has already said the message wasn't sent.
      let compactionStopped = false;
      // Tokens accumulate in `reply`/`thought` and reach React in batches.
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        setStreaming(reply);
        setThinking(thought);
        if (logChanged) setLogVersion((v) => v + 1);
        logChanged = false;
        for (const [callId, p] of progress) {
          const entry = toolLines.get(callId);
          if (entry) updateMessage(entry.line, { tool: { label: entry.label, status: "running", summary: p.line, steps: p.steps } });
        }
        progress.clear();
      };
      const scheduleFlush = () => {
        if (over) return;
        flushTimer ??= setTimeout(flush, STREAM_FLUSH_MS);
      };

      try {
        for await (const event of session.send(text, { forModel })) {
          switch (event.type) {
            case "status":
              setWaitingFor(event.status === "waiting_for_mcp" ? "Waiting for MCP servers to start…" : null);
              setCompacting(event.status === "compacting");
              break;
            case "compaction":
              setCompacting(false);
              syncUsage();
              reportCompaction(event.result, true);
              compactionStopped = !event.result.compacted && event.result.reason === "stopped";
              break;
            case "subagent_progress":
              if (over) break;
              progress.set(event.callId, event.progress);
              steps.set(event.callId, event.progress.steps);
              scheduleFlush();
              break;
            case "subagent": {
              // Subagents' requests count toward the session's tokens and cost.
              if (event.event.type === "usage") setTotals(session.usage().totals);
              const log = logs.get(event.callId);
              if (over || !log) break;
              applyEvent(log, event.event);
              // Only the open view costs a render; the others just keep their log.
              if (isViewed(log)) {
                logChanged = true;
                scheduleFlush();
              }
              break;
            }
            case "thinking_delta":
              thought += event.text;
              scheduleFlush();
              break;
            case "text_delta":
              if (thought && !thoughtMs) thoughtMs = Date.now() - stepStarted;
              reply += event.text;
              scheduleFlush();
              break;
            case "assistant":
              flush(); // a step ended: show everything before moving on
              noteThought();
              addMessage({ role: "assistant", text: event.text });
              reply = "";
              setStreaming("");
              break;
            case "tool_start": {
              flush();
              noteThought();
              setToolsRunning((n) => n + 1);
              if (event.call.name === "agent") setAgentsRunning((n) => n + 1);
              // Providers reuse call ids from step to step (Ollama's call_0…):
              // nothing from an earlier call with this id carries over.
              steps.delete(event.call.id);
              progress.delete(event.call.id);
              ended.delete(event.call.id);
              const line = addMessage({ role: "tool", text: event.call.name, tool: { label: event.label, status: "running" } });
              toolLines.set(event.call.id, { label: event.label, line });
              logs.delete(event.call.id);
              if (event.call.name === "agent") {
                const log = createAgentLog({ title: event.label, prompt: agentArgs(event.call.arguments).prompt });
                logs.set(event.call.id, log);
                agentLogs.current.set(`msg-${line}`, log);
              }
              break;
            }
            case "tool_end": {
              const { result } = event;
              const entry = toolLines.get(event.call.id);
              progress.delete(event.call.id); // a late progress flush mustn't turn it back to "running"
              const callSteps = steps.get(event.call.id);
              steps.delete(event.call.id);
              ended.add(event.call.id);
              // A plain failure shows its message; a subagent that stopped shows its own summary.
              const summary = result.isError && result.summary === "error" ? result.output.split("\n")[0] : result.summary;
              const status = result.declined ? "declined" : result.isError ? "error" : "done";
              if (entry) updateMessage(entry.line, { tool: { label: result.label, status, summary, steps: callSteps } });
              const log = logs.get(event.call.id);
              if (log) {
                // It may have ended before its loop started (a failed check): either way it's over now.
                log.running = false;
                logs.delete(event.call.id);
                if (isViewed(log)) setLogVersion((v) => v + 1);
              }
              setToolsRunning((n) => Math.max(0, n - 1));
              if (event.call.name === "agent") setAgentsRunning((n) => Math.max(0, n - 1));
              stepStarted = Date.now();
              break;
            }
            case "usage":
              syncUsage();
              break;
            case "error":
              addMessage({ role: "system", text: event.message, isError: true });
              break;
            case "done":
              if (event.reason === "aborted") addMessage({ role: "system", text: "Interrupted." });
              if (event.reason === "declined") addMessage({ role: "system", text: "Stopped. Tell Marv what to do instead." });
              if (event.reason === "length") addMessage({ role: "system", text: "The reply was cut off: it hit the model's output limit." });
              break;
            case "turn_end":
              // Stopped before the loop began: while waiting for MCP servers (or compacting, which said so itself).
              if (event.reason === "interrupted" && !compactionStopped) addMessage({ role: "system", text: "Interrupted." });
              break;
          }
        }
      } catch (err) {
        // Drawing an event failed; leaving the loop has already stopped the turn.
        addMessage({ role: "system", text: `Error: ${(err as Error).message}`, isError: true });
      } finally {
        over = true;
        if (flushTimer) clearTimeout(flushTimer);
        // The turn ended early: close the entries it never ended.
        for (const [callId, entry] of toolLines) {
          if (!ended.has(callId)) updateMessage(entry.line, { tool: { label: entry.label, status: "error", summary: "interrupted", steps: steps.get(callId) } });
        }
        for (const log of logs.values()) log.running = false;
        if ([...logs.values()].some(isViewed)) setLogVersion((v) => v + 1);
        noteThought();
        // Anything still queued belongs to this turn, which is over: declined.
        declineAll();
        abortRef.current = null;
        setStreaming(null);
        setWaitingFor(null);
        setCompacting(false);
        setToolsRunning(0);
        setAgentsRunning(0);
        syncUsage();
      }
    },
    [session, addMessage, updateMessage, declineAll, syncUsage, reportCompaction],
  );
```

- [ ] **Step 4: `/compact` and the ratings go through the session**

In `handleSubmit`, the `compact` case becomes:

```tsx
      case "compact":
        void compact(action.focus);
        break;
```

Replace `rateLastTurn` with:

```tsx
  /** /good, /bad, /label: feedback on the latest turn of this session, in its trajectory. */
  const rateLastTurn = ({ score, note, labels }: Extract<CommandAction, { type: "feedback" }>) => {
    const outcome = session.rate({ score, note, labels });
    if (outcome === "off") {
      addMessage({ role: "system", text: "Trajectory logging is off, so there's nothing to rate (/trajectories on).", isError: true });
    } else if (outcome === "nothing") {
      addMessage({ role: "system", text: "Nothing to rate yet: ratings apply to the last turn of this conversation.", isError: true });
    } else {
      const what = labels ? `Labeled the last turn: ${labels.join(", ")}` : `Rated the last turn: ${score > 0 ? "good" : "bad"}`;
      addMessage({ role: "system", text: `${what}${note ? ` (${note})` : ""}.` });
    }
  };
```

- [ ] **Step 5: Saving and resuming go through the session**

Replace everything from `  // The session as it is now, saved. Reads refs, so it's also right when called on the way out, after unmounting.` through the end of the `marv -c / marv -r` effect (the `useEffect` whose dependency list is `[resume, sessions, phase, root, restore, openPicker, addMessage]`) with:

```tsx
  // Save once a turn is over (not mid-run), shortly after things settle. The session saves after each turn too;
  // this also catches what Marv prints between turns (/cost, /memory…), which is part of the transcript.
  useEffect(() => {
    if (!sessions || busy) return;
    const timer = setTimeout(() => void session.save().catch(() => {}), 200);
    return () => clearTimeout(timer);
  }, [sessions, busy, items, totals, session]);

  // On the way out (cli.tsx awaits this before exiting): quitting cancels the timers above, which could lose the
  // last turn, so save now, and let pending trajectory records reach the disk.
  useEffect(() => {
    onFlush?.(() => session.flush());
  }, [onFlush, session]);

  const WORKING = "Marv is working: stop the current turn (Esc) before resuming another session.";

  /** Shows a session the session object has just resumed: its transcript, its cost, and where it left off. */
  const showResumed = useCallback(
    (resumed: Resumed) => {
      selection.reset();
      agentLogs.current.clear();
      setViewing(null);
      // Never lower it: an update still on its way for a message of this process must not hit a restored one.
      nextId.current = Math.max(nextId.current, Math.max(0, ...resumed.transcript.map((m) => m.id)) + 1);
      syncUsage();
      const switched = resumed.model !== configRef.current.model ? ` (it used ${resumed.model}; continuing with ${configRef.current.model})` : "";
      setItems([
        { kind: "welcome", id: "welcome-0" },
        ...resumed.transcript.map((message) => ({ kind: "message" as const, id: `msg-${message.id}`, message })),
      ]);
      addMessage({ role: "system", text: `Resumed a session from ${timeAgo(resumed.updatedAt)}${switched}.` });
      setFollowKey((n) => n + 1);
    },
    [addMessage, syncUsage],
  );

  /** Swaps in a saved session. Never into a running turn: its reply would land in the other conversation, and be saved there. */
  const resumeSession = useCallback(
    async (id: string | "latest"): Promise<Resumed | null | "busy"> => {
      if (abortRef.current || session.busy) return "busy";
      try {
        return await session.resume(id);
      } catch (err) {
        if (session.busy) return "busy"; // a turn started while it loaded
        throw err;
      }
    },
    [session],
  );

  const openPicker = useCallback(async () => {
    if (!sessions) return;
    let list: SessionSummary[];
    try {
      list = (await sessions.list(root)).filter((s) => s.id !== session.id);
    } catch (err) {
      addMessage({ role: "system", isError: true, text: `Couldn't list the saved sessions: ${(err as Error).message}` });
      return;
    }
    // A turn started while the list loaded: don't put the picker over it.
    if (abortRef.current) addMessage({ role: "system", isError: true, text: WORKING });
    else if (list.length === 0) addMessage({ role: "system", text: "No saved sessions for this project yet." });
    else setPicker(list);
  }, [sessions, root, session, addMessage]);

  const pickSession = useCallback(
    async (id: string) => {
      setPicker(null);
      const resumed = await resumeSession(id).catch(() => null);
      if (resumed === "busy") addMessage({ role: "system", isError: true, text: WORKING });
      else if (resumed) showResumed(resumed);
      else addMessage({ role: "system", isError: true, text: "That session couldn't be loaded." });
    },
    [resumeSession, showResumed, addMessage],
  );

  // marv -c / marv -r
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !resume || !sessions || phase !== "main") return;
    resumed.current = true;
    if (resume === "pick") void openPicker();
    else {
      // Until it's loaded, the prompt keeps what's typed but doesn't send it (handleSubmit): a message sent now would
      // be swapped out by the restore.
      setLoadingSession(true);
      void resumeSession("latest")
        .then((latest) =>
          latest === "busy"
            ? addMessage({ role: "system", isError: true, text: WORKING })
            : latest
              ? showResumed(latest)
              : addMessage({ role: "system", text: "No saved session to continue in this project." }),
        )
        .catch((err: Error) => addMessage({ role: "system", isError: true, text: `Couldn't load the last session: ${err.message}` }))
        .finally(() => setLoadingSession(false));
    }
  }, [resume, sessions, phase, openPicker, resumeSession, showResumed, addMessage]);
```

- [ ] **Step 6: The status bar shows the session's provider**

In the JSX, both `StatusBar`s: replace `model={provider.name}` with `model={session.providerName}`.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: clean. If something is reported unused or missing, it's a leftover of the old code (`countUsage`, `trajectory`, `restore`, `saveSession`, `provider`, `system`, `offered`, `usageRef`, `sessionRef`, `conversation`): remove the leftover; don't bring the old code back.

- [ ] **Step 8: Run the App's tests, then everything**

Run: `bun test tests/app tests/render-performance tests/approval`
Expected: all pass, unchanged.

Run: `bun test`
Expected: all pass (the 640 from before plus the new ones), 1 skip.

If an App test fails, compare what it expects with the old `App.send()` (`git show HEAD~1:src/app.tsx`, or `main:src/app.tsx`): the transcript must read exactly as before. The usual causes are message wording or order around interrupts and compaction, and timing: events now arrive through the session's queue, so a test that waited one `tick()` may need `until(...)`. Fix the App or the session to match the old behavior; don't change the test's expectations.

- [ ] **Step 9: Try it by hand**

Run (from the worktree, with your real config untouched): `MARV_CONFIG_DIR=$(mktemp -d) bun run dev`, set up Ollama or OpenRouter, then: send a message, ask for a file to be read, `/compact`, `/clear`, `/cost`, quit, and `bun run dev -- -c` to continue it.
Expected: everything behaves as on `main`.

- [ ] **Step 10: Commit**

```bash
git add src/app.tsx
git commit -m "The App runs on MarvSession

App.send() now draws the session's events; the conversation, compaction,
MCP waiting, subagent wiring, trajectories and saving live in the session.
App keeps its props, so every existing test runs unchanged, and passing
them is the proof the TUI behaves exactly as before."
```

---

### Task 13: `createSession()` and the package entry

**Files:**
- Create: `src/sdk.ts`, `tests/sdk.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

Create `tests/sdk.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as sdk from "marv/sdk";
import { createSession, type SessionEvent, type Tool } from "marv/sdk";
import type { AgentEvent } from "../src/provider/types.ts";
import { ScriptedProvider } from "./fake-provider.ts";

let root: string;
let configDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-sdk-project-"));
  configDir = await mkdtemp(join(tmpdir(), "marv-sdk-config-"));
  await writeFile(join(root, "AGENTS.md"), "Always answer in French.");
  await mkdir(join(root, ".marv", "skills", "release-notes"), { recursive: true });
  await writeFile(join(root, ".marv", "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: Write release notes from git log\n---\nRun git log.");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

const say = (text: string): AgentEvent[] => [
  { type: "text_delta", text },
  { type: "done", reason: "stop" },
];
async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("the package entry exports what the README promises", () => {
  for (const name of ["createSession", "ToolError", "OllamaProvider", "OpenAICompatProvider", "SessionStore", "TrajectoryStore"]) {
    expect(sdk).toHaveProperty(name);
  }
});

test("by default nothing is read from disk", async () => {
  const provider = new ScriptedProvider([say("Hello.")]);
  const session = await createSession({ cwd: root, provider, configDir });
  await collect(session.send("hi"));
  const { system, tools } = provider.requests[0]!.options;
  expect(system).not.toContain("Always answer in French.");
  expect(tools!.map((t) => t.name)).not.toContain("skill");
  await session.close();
});

test("sources: ['project'] reads the repository's AGENTS.md and skills", async () => {
  const provider = new ScriptedProvider([say("Bonjour.")]);
  const session = await createSession({ cwd: root, provider, configDir, sources: ["project"] });
  await collect(session.send("hi"));
  const { system, tools } = provider.requests[0]!.options;
  expect(system).toContain("Always answer in French.");
  expect(system).toContain("release-notes");
  expect(tools!.map((t) => t.name)).toContain("skill");
  await session.close();
});

test("a tool of your own is offered and runs (the README example)", async () => {
  const clock: Tool = {
    name: "clock",
    description: "The current time.",
    input: z.object({}),
    label: () => "now",
    run: async () => ({ output: "12:00", summary: "12:00" }),
  };
  const provider = new ScriptedProvider([
    [{ type: "tool_call", call: { id: "c1", name: "clock", arguments: "{}" } }, { type: "done", reason: "tool_calls" }],
    say("It's noon."),
  ]);
  const session = await createSession({ cwd: root, provider, configDir, tools: [clock] });
  const events = await collect(session.send("what time is it?"));
  expect(provider.requests[0]!.options.tools!.map((t) => t.name)).toContain("clock");
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", result: expect.objectContaining({ output: "12:00" }) }));
  expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "end" });
  await session.close();
});

test("persist: true saves where marv -r finds it, and resume picks it up", async () => {
  const first = await createSession({ cwd: root, provider: new ScriptedProvider([say("Noted.")]), configDir, persist: true });
  await collect(first.send("remember 42"));
  await first.close();
  const provider = new ScriptedProvider([say("42.")]);
  const second = await createSession({ cwd: root, provider, configDir, persist: true, resume: "latest" });
  expect(second.id).toBe(first.id);
  await collect(second.send("what was it?"));
  expect(provider.requests[0]!.history.map((t) => t.text)).toEqual(["remember 42", "Noted.", "what was it?"]);
  await second.close();
});

test("resuming an id that doesn't exist fails", async () => {
  await expect(createSession({ cwd: root, provider: new ScriptedProvider([]), configDir, persist: true, resume: "nope" })).rejects.toThrow(/no saved session/);
});

test("a bad MCP server entry is reported in problems, not thrown", async () => {
  const session = await createSession({ cwd: root, provider: new ScriptedProvider([]), configDir, mcpServers: { bad__name: { command: "x" } } });
  expect(session.problems.join("\n")).toContain("bad__name");
  await session.close();
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test tests/sdk`
Expected: FAIL, the package `marv/sdk` can't be resolved (there's no `exports` yet).

- [ ] **Step 3: Write the entry point**

Create `src/sdk.ts`:

```ts
// The public entry point: `import { createSession } from "marv/sdk"`.
//
// A session is Marv without its terminal: the agent loop, the tools, subagents, MCP servers, compaction, saved
// sessions and trajectories, driven by your code. createSession() reads nothing from disk unless asked
// (`sources`), and without an `approve` callback only what yolo mode vouches for runs (edits outside .git,
// sandboxed commands without network); anything else goes back to the model as refused. Bun only, for now.
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { defaultConfigDir } from "./config/config.ts";
import { parseMcpServers, type McpServerConfig } from "./mcp/config.ts";
import { McpManager } from "./mcp/manager.ts";
import { McpTrust } from "./mcp/trust.ts";
import { projectKey } from "./paths.ts";
import type { ProviderOption } from "./provider/factory.ts";
import { MarvSession } from "./session.ts";
import { SessionStore } from "./sessions.ts";
import { loadSources, type Source } from "./sources.ts";
import { TrajectoryStore } from "./trajectory.ts";
import type { ApprovalRequest, Decision, Tool } from "./tools/types.ts";
import type { Message } from "./types.ts";

export interface SessionOptions {
  /** The project folder: the tools can't reach outside it. */
  cwd: string;
  /** { kind: "openrouter", apiKey, model? }, { kind: "ollama", model, host?, contextLength? }, or a Provider of your own. */
  provider: ProviderOption;
  /** What to read from disk: "user" (~/.marv: your skills, agents, memory, MCP servers) and "project" (AGENTS.md, .marv/, .mcp.json). Default: nothing. */
  sources?: Source[];
  /** Replaces Marv's system prompt, or adds to it. */
  systemPrompt?: string | { append: string };
  /** Your own tools, offered next to the built-in ones. */
  tools?: Tool[];
  /** MCP servers in .mcp.json's format: { name: { command, args?, env? } | { type: "http", url, headers? } }. */
  mcpServers?: Record<string, unknown>;
  /** Asked for every call that needs a yes. Without it, only what yolo mode vouches for runs. */
  approve?: (request: ApprovalRequest) => Promise<Decision>;
  /** Run bash in the bubblewrap sandbox (default true). */
  sandbox?: boolean;
  /** Run what the sandbox confines without asking (default true). */
  yolo?: boolean;
  /** Let thinking models reason before they answer (default false). */
  thinking?: boolean;
  /** Save the conversation (true: in ~/.marv/sessions, where `marv -r` finds it). Default false. */
  persist?: boolean | SessionStore;
  /** Log every turn for later analysis (true: in ~/.marv/trajectories). Default false. */
  trajectories?: boolean | TrajectoryStore;
  /** What the user saw, saved with the session; default: the messages and replies. */
  transcript?: () => Message[];
  /** Continue a saved session (needs `persist`): its id, or "latest" (if there's none yet, a new one starts). */
  resume?: string | "latest";
  /** Where Marv keeps its files (default ~/.marv, or $MARV_CONFIG_DIR). */
  configDir?: string;
}

/** true → the default store; a store → that one; false or absent → none. */
function storeFor<T>(option: boolean | T | undefined, make: () => T): T | undefined {
  if (option === true) return make();
  return option || undefined;
}

export async function createSession(options: SessionOptions): Promise<MarvSession> {
  const root = resolve(options.cwd);
  const configDir = options.configDir ?? defaultConfigDir(process.env);
  const loaded = await loadSources({ root, sources: options.sources ?? [], configDir });
  const given = options.mcpServers ? parseMcpServers(options.mcpServers, process.env) : { servers: [], problems: [] };
  const problems = [...loaded.problems, ...given.problems];
  // Servers given in code first; one from the config files with the same name is skipped.
  const servers: McpServerConfig[] = [...given.servers];
  for (const server of loaded.mcpServers) {
    if (servers.some((s) => s.name === server.name)) problems.push(`MCP server "${server.name}" from the config files was ignored: mcpServers has one with that name.`);
    else servers.push(server);
  }
  const mcp = servers.length ? new McpManager(servers, { root, version: pkg.version, trust: new McpTrust(join(configDir, "mcp-trust.json")) }) : undefined;
  void mcp?.start();

  const session = new MarvSession({
    root,
    provider: options.provider,
    thinking: options.thinking,
    version: pkg.version,
    instructions: loaded.instructions,
    skills: loaded.skills,
    agents: loaded.agents,
    memory: loaded.memory,
    mcp,
    ownsMcp: true,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
    approve: options.approve,
    sandbox: options.sandbox,
    yolo: options.yolo,
    sessions: storeFor(options.persist, () => new SessionStore(join(configDir, "sessions"))),
    trajectories: storeFor(options.trajectories, () => new TrajectoryStore(join(configDir, "trajectories"))),
    worktreesDir: join(configDir, "worktrees", projectKey(root)),
    transcript: options.transcript,
    problems,
  });
  if (options.resume) {
    const resumed = await session.resume(options.resume);
    if (!resumed && options.resume !== "latest") {
      await session.close();
      throw new Error(`There's no saved session "${options.resume}" for ${root} (resuming needs persist).`);
    }
  }
  return session;
}

export type { MarvSession as Session, SessionEvent, TurnEndReason, CompactResult, Resumed } from "./session.ts";
export type { ProviderOption } from "./provider/factory.ts";
export type { Source } from "./sources.ts";
export { ToolError } from "./tools/types.ts";
export type { Tool, ToolContext, ToolResult, ApprovalRequest, Decision, Preview, Scope } from "./tools/types.ts";
export type { Provider, AgentEvent, ChatTurn, StreamOptions, ToolCall, ToolSpec, Usage } from "./provider/types.ts";
export { OllamaProvider } from "./provider/ollama.ts";
export { OpenAICompatProvider } from "./provider/openai-compat.ts";
export type { LoopEvent } from "./agent.ts";
export type { Totals } from "./usage.ts";
export type { Message } from "./types.ts";
export { SessionStore } from "./sessions.ts";
export { TrajectoryStore } from "./trajectory.ts";
```

- [ ] **Step 4: The package entry**

In `package.json`, after `"type": "module",` add:

```json
  "exports": {
    "./sdk": "./src/sdk.ts",
    "./package.json": "./package.json"
  },
  "engines": {
    "bun": ">=1.3"
  },
  "files": [
    "src",
    "patches",
    "README.md"
  ],
```

Bun resolves a package's own name through `exports` (checked while planning), so `import "marv/sdk"` works from inside the repository too.

- [ ] **Step 5: Run the tests**

Run: `bun test tests/sdk && bun run typecheck`
Expected: 7 pass; clean.

- [ ] **Step 6: Make sure the SDK doesn't pull in the terminal UI**

Bundle the entry and look for Ink and React in it (an unminified bundle marks each module's source path in a comment):

Run: `out=$(mktemp -d) && bun build src/sdk.ts --target=bun --outfile=$out/sdk.js && grep -c "node_modules/ink/\|node_modules/react/\|src/ui/" $out/sdk.js`
Expected: the build succeeds and the count is `0`. If it isn't, find the import chain from `src/session.ts` that reaches the UI and cut it (the SDK must not load the terminal UI).

- [ ] **Step 7: Commit**

```bash
git add src/sdk.ts tests/sdk.test.ts package.json
git commit -m "createSession(): Marv as a library (marv/sdk)

Reads nothing from disk unless asked (sources), runs only what yolo vouches
for unless given an approver, and saves or logs only when asked (persist,
trajectories). The package exports ./sdk; Bun only for now."
```

---

### Task 14: Docs and the example

**Files:**
- Create: `examples/sdk.ts`
- Modify: `tsconfig.json`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: The example**

Create `examples/sdk.ts`:

```ts
// Marv from code. Run it in a project folder:
//   OPENROUTER_API_KEY=sk-or-... bun /path/to/marv/examples/sdk.ts "what does this project do?"
import { createSession } from "marv/sdk";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("Set OPENROUTER_API_KEY first.");

const session = await createSession({
  cwd: process.cwd(),
  provider: { kind: "openrouter", apiKey },
  sources: ["project"], // the repository's AGENTS.md and .marv/ (nothing of yours)
});

for await (const event of session.send(process.argv[2] ?? "What does this project do?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "tool_start") console.log(`\n· ${event.call.name} ${event.label}`);
  if (event.type === "error") console.error(`\n${event.message}`);
}
console.log();
await session.close();
```

In `tsconfig.json`, change `"include": ["src", "tests", "scripts"]` to `"include": ["src", "tests", "scripts", "examples"]`.

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 2: README: a section before `## Development`**

Insert into `README.md`, before the `## Development` heading:

````markdown
## Using Marv from code

Marv's engine is a library too: `marv/sdk` gives your Bun program the same agent the terminal runs (the
tools, subagents, MCP servers, compaction, saved sessions), without the terminal.

```ts
import { createSession } from "marv/sdk";

const session = await createSession({
  cwd: "/path/to/project",
  provider: { kind: "openrouter", apiKey: process.env.OPENROUTER_API_KEY! },
  // or { kind: "ollama", model: "qwen3.5:9b" }, or a Provider of your own
});

for await (const event of session.send("Fix the failing test")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
await session.close();
```

- **Events.** `send()` streams one turn: `turn_start` first and `turn_end` last, always exactly once, with the
  model's text, tool calls (`tool_start`/`tool_end`), subagents' events (`subagent`, tagged with the call that
  started them) and compaction in between. Leaving the loop early interrupts the turn; so do `interrupt()` and
  a `signal`.
- **Approvals.** Pass `approve: async (request) => "yes" | "always" | "no"` to decide what runs. Without it,
  only what Marv's yolo mode vouches for runs (edits outside `.git`, sandboxed commands without network);
  anything else goes back to the model as refused, and it carries on.
- **Nothing from disk unless asked.** `sources: ["project"]` reads the repository's `AGENTS.md`, `.marv/` and
  `.mcp.json` (whose servers still need trusting); `"user"` reads your `~/.marv` (skills, agents, memory, MCP
  servers). `persist: true` saves the conversation where `marv -r` finds it; `trajectories: true` logs it.
- **Your own tools:** `tools: [{ name, description, input: z.object({...}), label, run }]`.
- **Bun only** for now.

`examples/sdk.ts` is a complete script.
````

- [ ] **Step 3: CLAUDE.md**

Make these edits in `CLAUDE.md`:

1. Add a new bullet right after the **Agent loop** bullet:

```markdown
- **Session (`src/session.ts`)**: `MarvSession` is Marv without a UI, and the TUI's engine. It holds the conversation (what the model sees), the providers (through a `ProviderFactory`, `src/provider/factory.ts`: the TUI makes it from its `Config` with `configFactory`, the SDK from a `ProviderOption`; subagent types with another model, and OpenRouter's reasoning switch once the model list answers), the system prompt and tool specs (built once per conversation), the "always" scopes (shared with subagents), the totals, and the trajectory and saved-session bookkeeping. `send(text)` runs one turn and returns an async iterator of `SessionEvent`s: `turn_start` first and `turn_end` last, exactly once however it ends (`interrupted` when stopped before the loop began: waiting for MCP servers, or an automatic compaction), the main loop's `LoopEvent`s, `subagent`/`subagent_progress` (tagged with the agent call's id), `status` (`waiting_for_mcp`/`compacting`/`running`) and `compaction`. The loop's events and subagents' callbacks are merged through an `EventQueue` (`src/event-queue.ts`); leaving the loop early (break) interrupts the turn, and the session waits for the loop's cleanup, so every tool call has a result. One turn at a time: `send()`, `clear()`, `resume()`, `compact()` throw (or reject) during one; `configure()` never does, since a turn reads its settings when it starts. The approver it's given is wrapped: "always" scopes are answered by the session, and a stop answers pending approvals "no". Without an approver, only yolo-safe calls run (`runTool` checks for an approver after yolo) and the step limit is a hard stop. Saved 200 ms after each turn, and by `save()`/`flush()`; the client can hand over its own transcript (`transcript`), otherwise the user's messages and replies are saved.
- **SDK (`src/sdk.ts`, package entry `marv/sdk`)**: `createSession(options)` loads only the `sources` asked for (`src/sources.ts`: `"user"` is everything under `~/.marv`, project memory included; `"project"` is the repository's `AGENTS.md`, `.marv/` and `.mcp.json`; default: nothing), adds `mcpServers` given in code (`parseMcpServers`, trusted like personal ones), starts and owns the MCP servers, and makes the stores when `persist`/`trajectories` are `true`. Bun only (`engines.bun`); the SDK must never import Ink, React or `src/ui/`. `examples/sdk.ts` is a runnable example; `tests/sdk.test.ts` imports through `marv/sdk` (Bun resolves the package's own name via `exports`).
```

2. In the `src/app.tsx` bullet, replace "`src/app.tsx` holds all session state." with "`src/app.tsx` holds the UI state (transcript, approval queue, agent views, setup) and makes one `MarvSession` from its props (see **Session**), which holds the conversation and runs the turns." and replace "`conversation` (a ref of `ChatTurn[]`): **what the model sees**" with "the session's conversation (`ChatTurn[]`, inside `MarvSession`): **what the model sees**".

3. In the **Agent loop** bullet, replace "`App.send()` turns the events into transcript entries" with "`MarvSession` runs it once per turn, and `App.send()` turns the session's events into transcript entries".

4. In the **Prompt cache** bullet, replace "the system prompt is built once per session (`useMemo` in `App`)" with "the system prompt is built once per conversation (in `MarvSession`)".

5. In the **MCP servers** bullet, replace "`send()` waits for `mcp.ready` before its first request (busy from then on, with its own abort controller, so a second message can't start a second run and Esc/ctrl+c cancel the wait; shown as \"Waiting for MCP servers to start…\" where \"Thinking…\" would be; a failed start still lets the turn go on)" with "a turn waits for `mcp.ready` before its first request (the session emits `status: waiting_for_mcp`, shown as \"Waiting for MCP servers to start…\" where \"Thinking…\" would be; the turn is busy meanwhile, Esc/ctrl+c end it with `turn_end` `interrupted`, and a failed start still lets the turn go on)".

6. In the **Compaction** bullet, replace "`send()` first asks the model to summarize" with "the session first asks the model to summarize".

7. In the **Sessions** bullet, replace "`/clear` starts a new session." with "`/clear` starts a new session (`MarvSession.clear()`)." and "The App takes `sessions` (a `SessionStore`) and `resume` props; without `sessions` nothing is saved (most tests)." with "The App takes `sessions` (a `SessionStore`) and `resume` props and hands the store to its session; without it nothing is saved (most tests). The saved-file type is `SavedSession`."

8. In the **Trajectories** bullet, replace "the App takes a `TrajectoryStore` prop (none in most tests: nothing is logged)" with "the App takes a `TrajectoryStore` prop and hands it to its session (none in most tests: nothing is logged)".

9. In **Commands**, add after `bun run typecheck`: `bun examples/sdk.ts "question"   # the SDK, from code (needs OPENROUTER_API_KEY)`.

- [ ] **Step 4: Commit**

```bash
git add examples/sdk.ts tsconfig.json README.md CLAUDE.md
git commit -m "Docs: using Marv from code (marv/sdk)

README section and a runnable example; CLAUDE.md describes MarvSession,
the SDK entry, and where the App's old responsibilities went."
```

---

### Task 15: Final check

- [ ] **Step 1: Everything, five times** (the App tests are timing-sensitive; flakes show up in repeats)

Run: `bun run typecheck && for i in 1 2 3 4 5; do bun test 2>&1 | tail -4; done`
Expected: clean; every run all pass, 1 skip.

- [ ] **Step 2: The example against a real model** (optional; needs a key or a local Ollama)

Run: `cd /tmp && OPENROUTER_API_KEY=... bun ~/.config/superpowers/worktrees/Marv-agent/sdk-session/examples/sdk.ts "list the files here"`
Expected: a streamed answer with tool lines; the process exits.

- [ ] **Step 3: Report**

Summarize for the user: what moved where, test counts before and after, anything that behaved differently and how it was resolved, and that the branch `sdk-session` is ready for review (superpowers:finishing-a-development-branch).
