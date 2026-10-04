# Subagents (Milestone 9) — design

Date: 2026-10-04
Status: approved in brainstorming, awaiting spec review

## Goal

Let Marv hand a task to a **subagent**: a separate run of the agent loop with
its own empty conversation, its own system prompt and its own tools, whose
final message comes back to the parent as a tool result. Subagents can run in
parallel, and a subagent can work in its own **git worktree** so several of
them can edit and build at the same time without colliding.

The immediate use is running the [superpowers](https://github.com/obra/superpowers)
skills, which dispatch implementer and reviewer subagents
(`subagent-driven-development`, `dispatching-parallel-agents`,
`requesting-code-review`) and define agent types as files
(`agents/code-reviewer.md`).

Why subagents at all:

1. **Context stays small.** A subagent may read 40 files; the parent gets a
   short report back instead of 40 file dumps.
2. **Fresh eyes.** A reviewer that never saw the implementer's reasoning judges
   the code on its own merits.
3. **Parallel work.** Independent tasks run at once; in worktrees, even builds
   and tests run side by side.

## Out of scope

- A TodoWrite / checklist tool (superpowers uses one too; separate, smaller piece of work).
- Subagents starting subagents.
- Compaction inside a subagent.
- Saving subagent conversations.
- Running subagents as separate processes (see "Approach").

## Approach

**In-process subagents.** The `agent` tool calls `runAgent()` again in the same
Marv process with a fresh history. A worktree subagent's `ToolContext.root` is
its worktree, and the existing confinement keys off `root`:
`resolveInProject()` for the file tools, bwrap's writable bind for `bash`.

Rejected: a child `marv --headless` process per subagent inside bwrap. Stronger
isolation (file tools in the kernel sandbox too), but the API key and network
would have to enter the sandbox, which today deliberately clears the
environment, and it needs a headless mode and a process protocol. Roughly 3×
the work against a threat Marv doesn't have: the model only acts through tools,
which are already confined.

## 1. Agent types (`src/agents.ts`)

Modeled on `src/skills.ts`.

- **Locations:** `.marv/agents/<name>.md` (project) and `~/.marv/agents/<name>.md`
  (personal). Project wins a name clash. Loaded once in `cli.tsx`; broken files
  are skipped and reported in the startup notice and by `/agents`.
- **Format:** YAML frontmatter (parsed with `Bun.YAML`), then the agent's system prompt.

  ```md
  ---
  name: code-reviewer            # required; lowercase letters, digits, dashes
  description: Use when …        # required; how the model knows when to use it
  tools: read_file, grep, glob   # optional; comma string or YAML list; default = all subagent tools
  model: inherit                 # optional; "inherit" (default) or a model id on the same provider
  ---
  You are a Senior Code Reviewer…
  ```

  `tools` also accepts Claude Code's names, mapped to Marv's:
  `Read`→`read_file`, `Grep`→`grep`, `Glob`→`glob`, `Edit`→`edit_file`,
  `Write`→`write_file`, `Bash`→`bash`. An unknown tool name makes the file a
  reported problem (not silently dropped). Asking for `agent` or `memory` is
  also a problem: subagents never get those.
- **Built-in `general-purpose`:** always available, every subagent tool, no extra body.
  A file named `general-purpose` overrides it.
- **Subagent tools:** `read_file`, `glob`, `grep`, `skill` (only when skills
  exist), `edit_file`, `write_file`, `bash`. Never `agent` (no nesting) or
  `memory` (memory persists across sessions; only the main agent changes it,
  with approval).
- **Subagent system prompt:** a shared preamble (working directory, date, tool
  guidance, the project's `AGENTS.md`, the skills list when there are skills,
  and: "your final message is your report to the agent that called you; be
  complete, the user won't see your steps"; for worktree runs also: "you are in
  a fresh git worktree on branch X; gitignored files such as node_modules and
  build output are absent, so install dependencies (bash with network: true)
  before building; commit your work") followed by the agent file's body. No
  Memory section.
- **Lookup:** exact name first; if not found and the name has a `prefix:`,
  retry without it (`superpowers:code-reviewer` → `code-reviewer`), so
  superpowers' text works unedited. Not found → `ToolError` listing the types.
- **Main system prompt:** gains an `# Agents` section (name + description of
  each type, plus a sentence on when to delegate and that consecutive `agent`
  calls in one reply run in parallel). Built once per session like the skills
  list, so the prompt cache holds.
- **`/agents`:** lists types (name, source, description, tools, model) and
  broken files, rendered as Markdown like `/skills`.

## 2. The `agent` tool and the loop

### Tool (`src/tools/agent.ts`)

```ts
agent({
  type?: string,         // default "general-purpose"
  description: string,   // 3–5 words, for the transcript and the branch name
  prompt: string,        // the complete task; the subagent sees nothing else
  isolation?: "worktree"
})
```

`run()`:

1. Resolve the type; build the subagent's system prompt and tool specs
   (deterministic: the same type produces the same bytes all day, so repeated
   dispatches of one type hit the cache). Provider: the parent's, or
   `createProvider({ ...config, model })` when the type sets a model.
2. If `isolation: "worktree"`, create the worktree (section 3).
3. `runAgent()` with history `[{ role: "user", text: prompt }]`,
   `maxSteps: 50`, the parent's abort signal, and a `runTool` whose context has
   the subagent's `root`, `approve` (section 4) and tools.
4. Consume events: count tool calls, track the current action, add usage to
   the session totals, and report each change through `ctx.onProgress`.
5. Finish the worktree if any (section 3).
6. Return `output` = the last assistant message (+ the branch line for
   worktrees). Summary: `done · 6 tools · 41.2k tokens`. If the subagent ended
   with `error`, `max_steps`, `aborted` or `length`, return whatever text it
   had plus a note saying why, with `isError: true`. If it ended `declined`,
   set `declined: true` (section 4).

New `ToolContext` fields: `callId` (set by `runTool`), `writable` (extra
writable folders for bash), and `agentHost?: AgentHost` (agent types,
`providerFor(model)`, cwd, AGENTS.md, worktrees dir, `onUsage`, `onProgress`).
Only the main agent's context has an `agentHost`, so subagents can't start
subagents. A subagent's approval requests carry `ApprovalRequest.agent` (who asks).

### Loop (`src/agent.ts`)

- `Tool` gains `parallel?: true` (set only on `agent`). `runAgent` receives a
  predicate `isParallel(call)`.
- A **run of consecutive parallel calls** in one reply starts together, at most
  4 running at once (`MAX_PARALLEL_AGENTS`), the rest queued. `tool_start` is
  yielded for each as it starts; `tool_end` as each finishes.
- Results are appended to history **in call order**, after the whole run
  finishes, so history (and therefore every request) is deterministic.
- Abort: the signal reaches every subagent; queued calls get the existing
  "Interrupted…" result. Every call still gets a result.
- Declined: if any call in the run is declined, the other calls in that run
  still finish; then `runAgent` ends with `declined`.

## 3. Worktrees

- **Location:** `~/.marv/worktrees/<project>/<id>/`, outside the project, so it
  doesn't appear in the parent's `git ls-files` and isn't writable by the
  parent's sandbox.
- **Preview (before approval):** not a git repo → `ToolError` ("dispatch without
  isolation"). Shows the base commit (`HEAD`, short hash) and warns when the
  main folder has uncommitted changes: they won't be in the worktree.
- **Create:** `git worktree add -b marv/<slug>-<4 hex> <dir> HEAD`; slug from
  `description` (lowercase, dashes, ≤40 chars).
- **Sandbox:** `sandboxArgs` gains `writable: string[]` and `readOnly: string[]`
  (mounted in that order, both after the hidden home). A worktree subagent's
  bash gets the repo's common git dir (`git rev-parse --git-common-dir`) as
  writable, because commits write objects and refs there, and read-only on top:
  `.git/hooks`, `.git/config`, and its admin folder's `commondir` and `gitdir`.
  Why: hooks and config can make git run programs, and they'd run *outside*
  the sandbox the next time Marv or the user runs git; the pointers could
  redirect git to a fake repository. Second layer: Marv's own git calls on a
  worktree name its admin folder explicitly (`--git-dir`, `--work-tree`,
  ignoring the worktree's `.git` file) and pass `-c core.hooksPath=/dev/null
  -c core.fsmonitor=false`. Remaining, accepted: with `.git` writable a
  subagent could move other branches (e.g. `git branch -f main`), which the
  parent's merge would show; the same trust an approved `bash` in the main
  folder has.
- **Finish** (always, including error and abort): if the worktree has
  uncommitted changes, `git add -A && git commit -m "marv: <description>"`
  (`(interrupted)` appended after an abort or error), run outside the sandbox
  by Marv itself. Then `git worktree remove`. The branch stays. If any step
  fails, keep the worktree and include its path in the result.
- **Result line:** `Branch marv/task-2-parser-errors-a3f9: 2 commits on abc1234`
  (or `no changes` and the branch is deleted when there were no commits).
  The parent inspects and merges with ordinary, approved `bash` git commands,
  and deletes merged branches itself.
- **Dependencies (verify in implementation):** a fresh worktree lacks
  gitignored files. `~/.bun` is mounted read-only in the sandbox, so
  `bun install` may fail to write its cache. An integration test runs
  `bun install && bun test` in a worktree subagent under bwrap; if it fails,
  mount `~/.bun/install/cache` writable when `network: true`.

## 4. Approvals

- **Dispatch:** `Tool` gains `needsApproval?(input): boolean` (overrides
  `kind` per call). `agent` needs approval only with `isolation: "worktree"`.
  Preview: type, description, the start of the prompt, base commit,
  uncommitted-changes warning, and "edits and sandboxed commands run without
  asking inside its worktree". Scope: `{ key: "agent:worktree", description:
  "worktree subagents" }`.
- **Shared-folder subagent:** each write/execute action asks like the parent,
  with the label prefixed `[<type> · <description>] `. Session "don't ask
  again" grants are shared both ways.
- **Worktree subagent:** its `approve` answers "yes" automatically, except it
  defers to the real prompt (labeled as above) for:
  1. `bash` with `network: true` (the worktree limits what a command changes,
     not what it can send out);
  2. everything, when the sandbox is off or bwrap is unavailable.
- **Queue (`src/app.tsx`):** the single approval slot becomes a FIFO queue. The
  prompt shows the head and `1 of N waiting` when N > 1. A decision resolves
  the head and shows the next. "Always" also resolves any queued requests with
  the same scope key. Esc / ctrl+c resolves every queued request "no".
  (Fixes a latent bug: today a second concurrent request overwrites the first,
  whose promise never resolves.)
- **"No" inside a subagent:** the subagent stops (`declined`); its `agent`
  result has `declined: true`, so the parent stops after the current run of
  calls and the user can redirect.

## 5. UI

- **Agent entry:** a tool entry with a second, live line:

  ```
  ● agent implementer · Task 2: parser errors
    ⎿ worktree marv/task-2-parser-errors-a3f9 · 14 tools · edit_file src/parser.ts
  ```

  Running: isolation/branch (or `shared`), tool count, current action (tool
  label or `thinking…`). Finished: `done · 6 tools · 41.2k tokens · "<first
  line of report>"`, error color for errors/interrupts.
- **Render budget:** `onProgress` updates are merged into `App.send()`'s
  existing 33 ms flush (`STREAM_FLUSH_MS`).
- **ctrl+o:** toggles a detailed view of all agent entries: each one's tool
  calls (label + summary), last 20 kept per agent. Nothing else is kept.
- **Status bar:** `N agents running` while any run. Context/cache figures stay
  the parent's.
- **Sessions:** agent entries are saved in their final state; the parent
  conversation holds each report. Subagent conversations are not saved.
- **Cost:** subagent usage goes into session `Totals` (`/cost`, status bar).

## 6. Testing

No network; `ScriptedProvider` scripts parent and subagent replies; temp dirs
as roots.

- `tests/agents.test.ts`: project/personal loading and precedence; frontmatter
  problems reported; Claude Code tool names mapped; unknown / forbidden tools
  reported; superpowers' `code-reviewer.md` loads unchanged; prefixed lookup.
- `tests/agent.test.ts`: parallel calls run concurrently (finish in reverse
  order); history in call order; max 4 at once; abort answers every call; a
  "no" in a run stops after the run; the existing prefix test still passes.
- `tests/agent-tool.test.ts`: fresh history; tool list excludes `agent` and
  `memory`; report = last assistant message; step limit / error → partial
  output with `isError`; usage reaches totals; model override builds a provider.
- `tests/worktree.test.ts` (real git, temp repo): branch and base; leftover
  changes committed (incl. `(interrupted)`); folder removed, branch kept; no
  commits → branch deleted; uncommitted warning; not-a-repo fails before
  approval; `sandboxArgs` includes the git dir as writable.
- `tests/approval.test.tsx`: concurrent requests queue and none is lost; Esc
  answers all "no"; "always" drains matching queued requests; worktree
  auto-approval covers edits but not `network: true` and not with the sandbox
  off; shared-folder prompts carry the label.
- UI: live line updates and done summary; ctrl+o details; `N agents running`;
  `/agents`. `tests/render-performance.test.tsx`: 4 parallel agents reporting
  progress stay within the 33 ms batching.
- Integration (skipped without bwrap): a worktree subagent runs
  `bun install && bun test` in a temp Bun project.
- By hand: superpowers in `~/.marv/skills/`, `code-reviewer.md` in
  `~/.marv/agents/`; run `subagent-driven-development` on a small plan with
  OpenRouter, including a parallel dispatch.

## Docs

Update `CLAUDE.md` (architecture: agents, the `agent` tool, worktrees,
approval queue) and the README.
