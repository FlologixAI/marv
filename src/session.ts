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
