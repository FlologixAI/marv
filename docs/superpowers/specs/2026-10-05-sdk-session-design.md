# Marv as an SDK: the headless Session

## Goal

Make Marv usable as a library: `createSession()` gives other people's Bun programs (bots, CI fixers,
scripts) the same agent the `marv` TUI runs: the loop, tools, subagents, MCP, compaction, sessions and
trajectories, without Ink. The TUI becomes one client of that Session.

Today everything that turns `runAgent()` into "Marv" lives inside `App.send()` (`src/app.tsx`), mixed
with drawing: waiting for MCP, auto-compaction, trajectory recording, the subagent `AgentHost`, the
step-limit prompt, cleanup. This project moves the session half out and leaves the UI half behind.

This is the first of several projects. Out of scope here, each its own spec later:

1. **Permissions API**: `canUseTool` and allow/deny rules (`bash(git status)`).
2. **`marv -p`**: a headless CLI client (piped stdin, `--output-format json|stream-json`).
3. **Hooks**: pre/post tool use, stop.
4. **Fork, plugins.**
5. **Node support**: v1 is Bun only.

The option names below leave room for all of them. Running `npm publish` (and checking whether the
name is free) is a manual step outside this project.

## Decisions

- **Audience: other people.** A public package, so the surface is small and deliberate.
- **Runtime: Bun only.** The core uses Bun APIs in ~20 files; the package ships TypeScript source with
  `engines.bun`, no build step.
- **Nothing is read from disk unless asked.** `sources: ["user", "project"]` opts into what the CLI
  loads. A library must not quietly read the user's `~/.marv` or start a repository's MCP servers.
- **Without an `approve` callback, the CLI's defaults apply**: sandbox and yolo on, so yolo-safe calls
  run; any other call that needs approval gets the existing error result ("needs the user's approval,
  and there's no one to ask", from `runTool`), and the model carries on.
- **Approach: a `Session` whose `send()` is an async iterator of events**, like `runAgent()` and
  Claude's `query()`. Rejected: an observable state store (puts TUI concepts like transcript items in
  the public API) and a toolkit without a Session (every caller would rebuild `App.send()`).

## Public API (`src/sdk.ts`, package entry `marv/sdk`)

```ts
export async function createSession(options: SessionOptions): Promise<Session>;

interface SessionOptions {
  cwd: string;
  provider:
    | { kind: "openrouter"; apiKey: string; model?: string }
    | { kind: "ollama"; host?: string; model: string; contextLength?: number }
    | Provider;                               // or bring your own
  sources?: ("user" | "project")[];           // default []: nothing read from disk
  systemPrompt?: string | { append: string };
  tools?: Tool[];                             // extra in-process tools, next to the built-ins
  mcpServers?: Record<string, McpServerConfig>;
  approve?: (request: ApprovalRequest) => Promise<Decision>;
  sandbox?: boolean;                          // default true
  yolo?: boolean;                             // default true
  thinking?: boolean;                         // default false
  persist?: boolean | SessionStore;           // default false; true: ~/.marv/sessions
  trajectories?: boolean | TrajectoryStore;   // default false; true: ~/.marv/trajectories
  snapshot?: () => unknown;                   // the client's own data, saved with the session
  resume?: string | "latest";
}

interface Session {
  readonly id: string;
  send(text: string, options?: { forModel?: string; signal?: AbortSignal }): AsyncIterable<SessionEvent>;
  interrupt(): void;
  compact(focus?: string): Promise<CompactResult>;
  clear(): void;
  resume(id: string | "latest"): Promise<ResumeResult>;   // includes the saved snapshot
  configure(changes: { provider?: SessionOptions["provider"]; sandbox?: boolean; yolo?: boolean; thinking?: boolean }): void;
  rate(feedback: { score: 1 | -1 | 0; note?: string; labels?: string[] }): void;  // 0: labels only
  usage(): { last?: Usage; totals: Totals; contextLength?: number };
  close(): Promise<void>;
}
```

Rules:

- **One turn at a time.** `send()` during a turn throws; so do `clear()`, `resume()`, `configure()`
  and `compact()`.
- **The Session outlives a conversation.** MCP servers, the provider and the loaded sources live as
  long as the object; `clear()` and `resume()` swap the conversation inside it. `clear()` reloads
  memory (as `/clear` does today) and starts a new id.
- **The prompt cache holds.** The system prompt and tool specs are built once per conversation, the
  history is only appended to (except compaction), and `configure()` changes nothing the model sees
  except the provider.
- `configure()` takes effect from the next turn. A provider change restarts the cache, as `/model` does
  today.
- `rate()` writes trajectory feedback for the last turn (`/good`, `/bad`, `/label`); it's a no-op
  when trajectories are off.
- `close()` closes MCP servers and flushes the pending session save and the trajectory.

## Events

```ts
type SessionEvent =
  | { type: "turn_start"; turn: string }
  | { type: "status"; status: "waiting_for_mcp" | "compacting" | "running" }
  | LoopEvent                                   // the main agent, as runAgent yields them
  | { type: "subagent"; callId: string; event: LoopEvent }
  | { type: "subagent_progress"; callId: string; progress: AgentProgress }
  | { type: "compacted"; summary: string; automatic: boolean; tokensBefore?: number }
  | { type: "compact_failed"; error: string }
  | { type: "turn_end"; turn: string; reason: DoneReason | "interrupted" | "error" };
```

- **Every `send()` yields exactly one `turn_start` first and one `turn_end` last**, including when
  it's interrupted while waiting for MCP, when an automatic compaction is stopped (`interrupted`, and the
  message isn't sent, as today), and when the loop throws (`error`).
- **Events are raw**: one `text_delta` per chunk. The 33 ms batching is drawing, so it stays in the TUI.
- **Subagent events share the stream.** A subagent runs while the main loop awaits its `agent` call, so
  its events arrive through `AgentHost.onEvent`/`onProgress` callbacks, not the loop's iterator.
  `send()` reads from an internal queue (`src/event-queue.ts`) that both feed, so the consumer sees one
  ordered stream. The queue is unbounded: callbacks can't be slowed down, and the events are small.
- **Leaving the loop interrupts the turn.** `break` (the iterator's `return()`) is treated like
  `interrupt()`: abort, decline queued approvals, the same cleanup. Every tool call still gets a result,
  so the saved history stays valid.
- **Approvals don't go through the stream** but through the `approve` callback, so a consumer never
  has to answer one from inside its own iteration (an easy deadlock). `"always"` adds the request's
  scope to the Session's set, shared by the main agent and its subagents, as today.

What the TUI shows is derived from these events in the TUI: "✻ Thought for Ns", tool entries going
running → done, the running counters, and each subagent's `AgentLog` (`applyEvent` already takes
`LoopEvent`s).

## Components

### New

- **`src/session.ts`**: `createSession()` and the class behind `Session`. It takes over from `App`:
  the conversation, the system prompt and tool specs, the provider (with the OpenRouter model-info
  lookup for context length, prices and reasoning, and remaking the provider once it arrives), the last
  usage and the totals, the "always" scopes, the turn's abort controller, waiting for `mcp.ready`,
  auto-compaction (`COMPACT_AT`), the `AgentHost`, the `AgentRecorder`s and trajectory records
  (`session`, `turn_start`, implicit feedback via `classifyReply`, `subagent_start`, `compact`), the
  step-limit question (asked through `approve`, scope `continue`; with no approver the run stops at the
  limit), and the session save 200 ms after each turn.
- **`src/sources.ts`**: `loadSources(cwd, sources)` built from the existing loaders.
  `"user"`: personal skills, agents and memory, `~/.marv/mcp.json`. `"project"`: `AGENTS.md`,
  `.marv/skills`, `.marv/agents`, project memory, `.mcp.json` (still started only once trusted).
  Problems are returned, not thrown, as today. `~/.marv/config.json` is not a source: the caller
  resolves the provider (the CLI keeps reading that file and passes the provider in).
- **`src/event-queue.ts`**: a push/close async queue; `close()` ends iteration after the queued
  events.
- **`src/sdk.ts`**: the public entry. Exports `createSession`, the option, event and result types,
  `Tool`, `ToolError` and the tool types custom tools need, and the built-in providers.

### Changed

- **`src/sessions.ts`**: the saved-file `Session` type becomes `SavedSession`, so the public
  `Session` is free. The saved data gains an opaque snapshot field for the client; the TUI's transcript
  goes there and is validated by the TUI when it comes back. Files saved by the current version still
  load.
- **`src/app.tsx`**: keeps the transcript, the 33 ms flush, the approval queue UI (now passed to the
  Session as its `approve` callback), agent views, mouse and selection, slash-command parsing and
  Setup. `send()` becomes "iterate `session.send()` and turn events into entries". `App`'s props
  don't change: it builds its Session from them, so every existing test runs as is.
- **`src/cli.tsx`**: passes `sources: ["user", "project"]` (through App's existing props) and calls
  the Session's flush on exit as `onFlush` does today.
- **`package.json`**: `"exports": { "./sdk": "./src/sdk.ts" }`, `"engines": { "bun": ">=1.3" }`, `files`.

## Error handling

Unchanged rules, now in one place: `runTool` never throws; every tool call gets a result (`finally` in
`runAgent`, `answerAllCalls` before saving); trajectory write failures go to the store's `onError`
(the TUI reports the first one, as today); a failed MCP start still lets the turn go on; an exception
in the loop ends the turn with `turn_end` reason `error` after an `error` event.

## Migration

One commit per step, all existing tests green after each:

1. Rename the saved-file `Session` to `SavedSession`.
2. Add `event-queue.ts` and `sources.ts` with their tests; nothing uses them yet.
3. Add `session.ts` with headless tests; `App` untouched.
4. Switch `App` to the Session: `send`, `compact`, `clear`, `restore`, and the commands that change
   config (`/model`, `/think`, `/sandbox`, `/yolo`) and rate turns (`/good`, `/bad`, `/label`).
   `tests/render-performance.test.tsx` must pass: the stream now goes through one more layer.
5. Add `sdk.ts`, the `package.json` fields, an SDK section in the README with a runnable
   `examples/sdk.ts`, and update CLAUDE.md.

## Testing

`tests/session.test.ts` (`ScriptedProvider`, temp dirs, a temp `HOME`):

- One `turn_start` and one `turn_end` per turn: normal end, interrupted while waiting for MCP,
  automatic compaction stopped, loop throws, `break` in the middle of tools. Each time, every tool call
  in the saved history has a result.
- Subagent events arrive in the same stream, tagged with their `callId`; the main loop's events stay in
  order.
- No approver: an edit and a sandboxed offline command run; a call that isn't yolo-safe gets the
  error result and the turn continues; at the step limit the run stops. `"always"` is remembered for its
  scope.
- `sources: []` reads nothing: a planted `AGENTS.md`, `.mcp.json`, `.marv/skills` and `~/.marv`
  stay out of the system prompt and the tools. `["user", "project"]` loads them.
- `send()`, `clear()`, `resume()`, `configure()` and `compact()` during a turn throw.
- Prompt cache: across several turns, with `configure({ yolo })` between them, every request extends
  the previous one exactly.
- Persistence: save, then `resume()` restores the conversation, totals and snapshot; a session file
  written by the current version loads.

`tests/sdk.test.ts` imports through the package entry (`marv/sdk`), checks the exports the README
promises, and runs the README example against a fake provider.

The 640 existing tests, unchanged, are the check that the TUI behaves exactly as before.
