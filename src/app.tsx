import { join } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput, useWindowSize, type DOMElement } from "ink";
import { DEFAULT_MAX_STEPS, runAgent } from "./agent.ts";
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
import { classifyReply } from "./feedback.ts";
import { runGit } from "./git.ts";
import { projectKey, shortenHome } from "./paths.ts";
import { mouse, type MouseEvent } from "./mouse.ts";
import { createProvider } from "./provider/index.ts";
import { listModels, type ModelInfo } from "./provider/models.ts";
import type { ChatTurn, Provider, Usage } from "./provider/types.ts";
import { selection } from "./selection.ts";
import { systemPrompt } from "./prompt.ts";
import { addUsage, costText, emptyTotals, tokens, type Prices, type Totals } from "./usage.ts";
import { COMPACT_AT, compactedHistory, summarize } from "./compact.ts";
import { addMemory, findMemory, loadMemory, removeMemory, type Memories, type MemoryPaths } from "./memory.ts";
import { newSession, timeAgo, type Session, type SessionStore, type SessionSummary } from "./sessions.ts";
import { skillMessage, type Skill } from "./skills.ts";
import { AgentRecorder, type Trajectory, type TrajectoryRecord, type TrajectoryStore } from "./trajectory.ts";
import { isParallelCall, runTool, tools as builtinTools, toolSpecsFor } from "./tools/index.ts";
import type { McpManager } from "./mcp/manager.ts";
import type { AgentHost, AgentProgress, ApprovalRequest, Decision } from "./tools/types.ts";
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

const EXIT_CONFIRM_MS = 1500;
const NOTICE_MS = 2000;
/**
 * Streamed text is shown at most this often (Ink draws at most 30 frames/s
 * anyway). Updating React on every token re-parsed the whole Markdown reply
 * for frames nobody would see.
 */
const STREAM_FLUSH_MS = 33;

/** What an agent call asked for: its task (the first entry in its view) and the rest, for its trajectory. */
function agentArgs(args: string): { prompt: string; type: string; description: string; isolation?: string } {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(args) as Record<string, unknown>;
  } catch {}
  const text = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
  return { prompt: text("prompt") ?? "", type: text("type") ?? "general-purpose", description: text("description") ?? "", isolation: text("isolation") };
}

/** The project's commit, so a trajectory says what code a run started from. */
function gitHead(root: string): string | undefined {
  const head = runGit(root, ["rev-parse", "HEAD"], { timeoutMs: 2000 });
  return head.ok ? head.out.trim() : undefined;
}
// Defaults defined once, so they're the same objects on every render (the
// system prompt and send() depend on them).
const DEFAULT_AGENTS: AgentType[] = [GENERAL_PURPOSE];
const NO_PROBLEMS: string[] = [];

interface Props {
  store: ConfigStore;
  /** The config file as loaded at startup; null on first run. */
  initialFile: FileConfig | null;
  env: Env;
  version: string;
  /** For display, e.g. "~/Projects/ekko-agent". */
  cwd: string;
  /** Absolute project root; the tools can't reach outside it. */
  root: string;
  /** The project's AGENTS.md, read at startup. */
  instructions?: string;
  /** Skills found at startup, and any that couldn't be loaded. */
  skills?: Skill[];
  skillProblems?: string[];
  /** 0 skips the splash entirely (used by tests). */
  splashMs?: number;
  /** Swappable so tests can inject an instant provider. */
  makeProvider?: (config: Config) => Provider;
  /** Swappable so tests don't touch the real clipboard. Returns how it copied. */
  copy?: (text: string) => Promise<string>;
  /** Swappable so tests don't hit OpenRouter or Ollama for the model picker. */
  loadModels?: (config: Pick<Config, "provider" | "baseUrl">) => Promise<ModelInfo[]>;
  /** Where sessions are saved; without it, nothing is saved. */
  sessions?: SessionStore;
  /** Where every turn is logged (trajectories); without it, nothing is logged. */
  trajectories?: TrajectoryStore;
  /** The session's MCP servers (already starting); their tools join the built-in ones. */
  mcp?: McpManager;
  /** MCP config files that couldn't be read, and why. */
  mcpProblems?: string[];
  /** Start by resuming: the latest session here (marv -c), or a picker (marv -r). */
  resume?: "latest" | "pick";
  /** Where memory lives, and what it held at startup. */
  memory?: { paths: MemoryPaths; initial: Memories };
  /** Agent types the agent tool can start, and files that couldn't be loaded. */
  agents?: AgentType[];
  agentProblems?: string[];
  /** Where subagents' worktrees go (~/.marv/worktrees/<project>); without it, no worktrees. */
  worktreesDir?: string;
}

// "model" is the /model picker: the setup screen, starting at the model step.
type SetupMode = "first-run" | "reconfigure" | "model" | null;

export function App({
  store,
  initialFile,
  env,
  version,
  cwd,
  root,
  instructions,
  skills = [],
  skillProblems = [],
  splashMs = 1200,
  makeProvider = createProvider,
  copy = copyToClipboard,
  loadModels = listModels,
  sessions,
  trajectories,
  mcp,
  mcpProblems = NO_PROBLEMS,
  resume,
  memory,
  agents = DEFAULT_AGENTS,
  agentProblems = NO_PROBLEMS,
  worktreesDir,
}: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [phase, setPhase] = useState<"splash" | "main">(splashMs > 0 ? "splash" : "main");

  // Config: the saved file + env overrides → the Config we run with → a Provider.
  const [file, setFile] = useState(initialFile);
  const config = useMemo(() => resolveConfig(file, env), [file, env]);
  const provider = useMemo(() => makeProvider(config), [makeProvider, config]);
  const [setupMode, setSetupMode] = useState<SetupMode>(() => (needsSetup(initialFile, config) ? "first-run" : null));

  // What the user sees (includes help text, errors, the welcome banner)…
  const [items, setItems] = useState<TranscriptItem[]>([{ kind: "welcome", id: "welcome-0" }]);
  // …versus what the model sees: user and assistant turns, tool calls and results.
  // Only ever appended to (until /clear): see the prompt cache note in agent.ts.
  const conversation = useRef<ChatTurn[]>([]);
  // The saved session this conversation is written to (a new one after /clear).
  const configRef = useRef(config);
  configRef.current = config;
  const sessionRef = useRef<Session>(newSession(root, config));
  // The trajectory log for the current session (one file per session), the
  // session whose "session" record this process wrote, and the latest turn
  // (what /good, /bad, /label and the next message's implicit feedback rate).
  const trajectoryRef = useRef<Trajectory | null>(null);
  const sessionLogged = useRef<string | null>(null);
  const lastTurn = useRef<{ id: string; session: string } | null>(null);
  const [picker, setPicker] = useState<SessionSummary[] | null>(null);

  // Built once per session, so they're byte-identical in every request.
  const specs = useMemo(() => toolSpecsFor({ hasSkills: skills.length > 0 }), [skills]);
  // Memory as of the start of this conversation (reloaded by /clear), so the system prompt stays fixed within it.
  const [memories, setMemories] = useState<Memories | undefined>(memory?.initial);
  const system = useMemo(
    () => systemPrompt({ cwd, tools: specs.map((t) => t.name), instructions, skills, memory: memories, agents, mcp: Boolean(mcp?.status().length) }),
    [cwd, specs, instructions, skills, memories, agents, mcp],
  );
  // What the model is offered: the built-in tools, then the MCP servers' (fixed once they've started, see McpManager).
  const offered = useCallback(
    () => (mcp ? { specs: [...specs, ...mcp.specs], tools: [...builtinTools, ...mcp.tools] } : { specs, tools: builtinTools }),
    [specs, mcp],
  );
  // Skills show up in the / menu next to the built-in commands.
  const menu = useMemo(() => [...commands, ...skills.map(({ name, description }) => ({ name, description }))], [skills]);
  // Token counts from the latest request (how full the context is)…
  const [usage, setUsage] = useState<Usage | null>(null);
  // …and for the whole session (survives /clear: that's money spent).
  const [totals, setTotals] = useState<Totals>(emptyTotals);
  // The model's context window and prices, looked up once per model (OpenRouter's list has them).
  const [modelInfo, setModelInfo] = useState<{ id: string; context?: number; prices: Prices } | null>(null);
  useEffect(() => {
    if (config.provider !== "openrouter") return;
    let cancelled = false;
    loadModels(config).then(
      (models) => {
        const m = models.find((model) => model.id === config.model);
        if (!cancelled && m) setModelInfo({ id: m.id, context: m.context, prices: m });
      },
      () => {}, // offline: no context size or price estimates, that's all
    );
    return () => {
      cancelled = true;
    };
  }, [config, loadModels]);
  const info = modelInfo?.id === config.model ? modelInfo : null;
  const contextLength = provider.contextLength ?? info?.context;
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const [compacting, setCompacting] = useState(false);

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
  // "Yes, don't ask again": scopes approved for the rest of this session.
  const alwaysAllowed = useRef(new Set<string>());

  const approve = useCallback(
    (request: ApprovalRequest): Promise<Decision> =>
      alwaysAllowed.current.has(request.scope.key)
        ? Promise.resolve("yes")
        : new Promise((resolve) => {
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
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  // Bumped on every submit so the transcript jumps back to the newest message.
  const [followKey, setFollowKey] = useState(0);

  const busy = streaming !== null;

  const addMessage = useCallback((message: Omit<Message, "id">) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { kind: "message", id: `msg-${id}`, message: { id, ...message } }]);
    return id;
  }, []);

  /** This session's trajectory log, or null when logging is off. */
  const trajectory = useCallback((): Trajectory | null => {
    if (!trajectories || !configRef.current.trajectories) return null;
    const id = sessionRef.current.id;
    if (trajectoryRef.current?.session !== id) {
      const log = trajectories.open(root, id);
      log.onError = (text) => addMessage({ role: "system", text, isError: true });
      trajectoryRef.current = log;
    }
    return trajectoryRef.current;
  }, [trajectories, root, addMessage]);

  const updateMessage = useCallback((id: number, patch: Partial<Message>) => {
    setItems((prev) =>
      prev.map((item) => (item.kind === "message" && item.message.id === id ? { ...item, message: { ...item.message, ...patch } } : item)),
    );
  }, []);

  const clearTranscript = useCallback(() => {
    selection.reset();
    agentLogs.current.clear();
    setViewing(null);
    // A new conversation picks up memories saved during the last one.
    if (memory) void loadMemory(memory.paths).then(setMemories);
    sessionRef.current = newSession(root, configRef.current);
    conversation.current = [];
    setUsage(null);
    setItems([{ kind: "welcome", id: "welcome-0" }]);
  }, [memory]);

  // Adds a request's tokens and cost to the session's totals.
  const countUsage = useCallback(
    (used: Usage) => {
      const local = configRef.current.provider === "ollama";
      setTotals((t) => ({ ...addUsage(t, used, info?.prices), local: (t.requests === 0 || t.local) && local }));
    },
    [info],
  );

  /**
   * Summarizes the conversation and continues from the summary (see
   * src/compact.ts). The transcript is untouched; only what the model sees
   * changes. Returns whether it compacted.
   */
  const compact = useCallback(
    async (focus: string | undefined, automatic: boolean) => {
      if (conversation.current.length === 0) {
        addMessage({ role: "system", text: "Nothing to compact yet." });
        return false;
      }
      const before = usageRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming("");
      setCompacting(true);
      const result = await summarize({
        provider,
        history: conversation.current,
        system,
        tools: offered().specs,
        signal: controller.signal,
        focus,
        onUsage: countUsage,
      });
      abortRef.current = null;
      setStreaming(null);
      setCompacting(false);

      if ("error" in result) {
        addMessage(
          controller.signal.aborted
            ? { role: "system", text: "Compaction stopped; nothing changed." }
            : { role: "system", isError: true, text: `Couldn't compact the conversation: ${result.error}` },
        );
        return false;
      }
      conversation.current = compactedHistory(result.summary);
      // From here the model sees the summary, not the turns before it: the trajectory needs it to say what the model saw.
      trajectory()?.write({ type: "compact", ...(lastTurn.current ? { turn: lastTurn.current.id } : {}), summary: result.summary });
      setUsage(null);
      const usedBefore = before ? before.promptTokens + before.completionTokens : undefined;
      const why = automatic && usedBefore && contextLength ? ` (the context was ${Math.round((100 * usedBefore) / contextLength)}% full)` : "";
      const size = usedBefore ? `: ${tokens(usedBefore)} → about ${tokens(Math.round(result.summary.length / 4))} tokens` : "";
      addMessage({
        role: "system",
        text: `✻ Compacted the conversation${why}${size}. Marv continues from a summary; your transcript is unchanged.`,
      });
      return true;
    },
    [provider, system, offered, countUsage, contextLength, addMessage, trajectory],
  );

  const send = useCallback(
    // `forModel`: what the model gets, when it differs from what the user typed (a /skill).
    async (text: string, forModel = text) => {
      addMessage({ role: "user", text });
      // MCP servers still starting: their tools must be in place before the first request (the list can't change after).
      if (mcp && !mcp.settled) {
        setNotice("Waiting for MCP servers to start…");
        await mcp.ready;
        setNotice(null);
      }
      const { specs: turnSpecs, tools: turnTools } = offered();
      // Trajectory: the session's setup (once), what this message says about
      // the last turn, and the new turn. Everything below records into it.
      const log = trajectory();
      const turn = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      if (log) {
        if (sessionLogged.current !== log.session) {
          const { provider: providerId, model } = configRef.current;
          log.write({ type: "session", root, marv: version, provider: providerId, model, system, tools: turnSpecs.map((t) => t.name), git: gitHead(root) });
          sessionLogged.current = log.session;
        }
        const previous = lastTurn.current;
        const signal = forModel === text ? classifyReply(text) : null; // a /skill's arguments aren't a reply
        if (previous?.session === log.session && signal) {
          log.write({ type: "feedback", turn: previous.id, score: signal.score, source: "implicit", phrase: signal.phrase });
        }
        log.write({
          type: "turn_start",
          turn,
          text,
          ...(forModel !== text ? { forModel } : {}),
          provider: config.provider,
          model: config.model,
          yolo: config.yolo,
          sandbox: config.sandbox,
        });
      }
      lastTurn.current = { id: turn, session: sessionRef.current.id };
      const record = (r: TrajectoryRecord) => log?.write(r);
      const main = new AgentRecorder(record, { turn, agent: "main" });
      // Subagents' recorders, by call id; ids are unique within the turn.
      const subRecorders = new Map<string, AgentRecorder>();
      let subagents = 0;
      // Nearly out of context: summarize first, so this message (and what follows) fits.
      const last = usageRef.current;
      if (contextLength && last && last.promptTokens + last.completionTokens >= contextLength * COMPACT_AT) {
        await compact(undefined, true);
      }
      conversation.current.push({ role: "user", text: forModel });

      const controller = new AbortController();
      abortRef.current = controller;
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
      // What the agent tool needs to start subagents. Only the main agent gets
      // one; what a subagent does reaches this conversation only as its tool result.
      const agentHost: AgentHost = {
        agents,
        cwd,
        instructions,
        worktreesDir,
        providerFor: (model) => (model ? makeProvider({ ...configRef.current, model }) : provider),
        onUsage: countUsage,
        onProgress: (callId, p) => {
          if (over) return;
          progress.set(callId, p);
          steps.set(callId, p.steps);
          scheduleFlush();
        },
        onEvent: (callId, event) => {
          subRecorders.get(callId)?.event(event);
          const log = logs.get(callId);
          if (over || !log) return;
          applyEvent(log, event);
          // Only the open view costs a render; the others just keep their log.
          if (isViewed(log)) {
            logChanged = true;
            scheduleFlush();
          }
        },
      };

      try {
        for await (const event of runAgent({
          provider,
          history: conversation.current,
          system,
          tools: turnSpecs,
          runTool: (call) =>
            runTool(
              call,
              { root, signal: controller.signal, approve, sandbox: config.sandbox, yolo: config.yolo, skills, memory: memory?.paths, agentHost },
              turnTools,
            ),
          signal: controller.signal,
          isParallel: isParallelCall,
          // At the step limit, ask (in the approval queue, so Esc still stops everything) instead of stopping dead.
          onLimit: async (steps) =>
            (await approve({
              tool: "continue",
              label: `${steps} steps`,
              preview: {
                title: `Keep going? Marv has taken ${steps} steps on this request without finishing`,
                note: `it asks again after another ${DEFAULT_MAX_STEPS}; no stops it here, and you can say what to do next`,
              },
              scope: { key: "continue", description: "the step limit" },
            })) !== "no",
        })) {
          main.event(event);
          switch (event.type) {
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
                const args = agentArgs(event.call.arguments);
                const subagent = `${turn}.${++subagents}`;
                record({ type: "subagent_start", turn, agent: "main", subagent, call: event.call.id, agentType: args.type, description: args.description, prompt: args.prompt, isolation: args.isolation });
                subRecorders.set(event.call.id, new AgentRecorder(record, { turn, agent: subagent }));
                const log = createAgentLog({ title: event.label, prompt: args.prompt });
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
              // A subagent that failed before its loop started never sent done.
              subRecorders.get(event.call.id)?.finish(result.isError ? "error" : "end");
              subRecorders.delete(event.call.id);
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
              setUsage(event.usage);
              countUsage(event.usage);
              break;
            case "error":
              addMessage({ role: "system", text: event.message, isError: true });
              break;
            case "done":
              if (event.reason === "aborted") addMessage({ role: "system", text: "Interrupted." });
              if (event.reason === "declined") addMessage({ role: "system", text: "Stopped. Tell Marv what to do instead." });
              if (event.reason === "length") addMessage({ role: "system", text: "The reply was cut off: it hit the model's output limit." });
              break;
          }
        }
      } catch (err) {
        addMessage({ role: "system", text: `Error: ${(err as Error).message}`, isError: true });
      } finally {
        over = true;
        for (const sub of subRecorders.values()) sub.finish("interrupted");
        main.finish("error"); // only if the loop threw: otherwise its done already ended the turn
        if (flushTimer) clearTimeout(flushTimer);
        // The loop stopped early (it threw): close the entries it never ended.
        for (const [callId, entry] of toolLines) {
          if (!ended.has(callId)) updateMessage(entry.line, { tool: { label: entry.label, status: "error", summary: "interrupted", steps: steps.get(callId) } });
        }
        for (const log of logs.values()) log.running = false;
        if ([...logs.values()].some(isViewed)) setLogVersion((v) => v + 1);
        noteThought();
        // Stop anything still running (a no-op after a normal end): if the loop
        // ended early (an exception), subagents still running in a parallel
        // group would otherwise carry on unseen, and could still ask for
        // approvals. Anything already queued belongs to this run, so it's declined.
        controller.abort();
        declineAll();
        abortRef.current = null;
        setStreaming(null);
        setToolsRunning(0);
        setAgentsRunning(0);
      }
    },
    [
      provider,
      addMessage,
      updateMessage,
      system,
      offered,
      mcp,
      skills,
      root,
      approve,
      declineAll,
      config.sandbox,
      config.yolo,
      config.provider,
      config.model,
      trajectory,
      version,
      countUsage,
      compact,
      contextLength,
      agents,
      cwd,
      instructions,
      worktreesDir,
      makeProvider,
      memory,
    ],
  );

  // /memory, /remember, /forget: you editing Marv's memory directly (no approval needed).
  const nextTime = "Marv will use it from the next conversation (/clear starts one).";
  const showMemory = async () => {
    if (!memory) return addMessage({ role: "system", text: "Memory isn't available." });
    const { personal, project } = await loadMemory(memory.paths);
    const list = (entries: string[]) => (entries.length ? entries.map((e) => `- ${e}`).join("\n") : "*(nothing yet)*");
    addMessage({
      role: "system",
      markdown: true,
      text: [
        `**Personal** (all projects): \`${shortenHome(memory.paths.personal)}\``,
        list(personal),
        `**This project**: \`${shortenHome(memory.paths.project)}\``,
        list(project),
        "Edit these files directly, use `/remember` and `/forget`, or ask Marv to remember or forget something.",
      ].join("\n\n"),
    });
  };
  const rememberNote = async (scope: "personal" | "project", text: string) => {
    if (!memory) return;
    const { added, error } = await addMemory(memory.paths[scope], text);
    addMessage(
      error
        ? { role: "system", isError: true, text: error }
        : { role: "system", text: added ? `Saved to ${scope} memory. ${nextTime}` : `That's already in ${scope} memory.` },
    );
  };
  const forgetNote = async (text: string) => {
    if (!memory) return;
    // Look in both scopes; remove only when exactly one memory matches.
    const matches = [
      ...(await findMemory(memory.paths.personal, text)).map((m) => ({ scope: "personal" as const, m })),
      ...(await findMemory(memory.paths.project, text)).map((m) => ({ scope: "project" as const, m })),
    ];
    if (matches.length !== 1) {
      return addMessage({
        role: "system",
        isError: true,
        text: matches.length ? `${matches.length} memories match; use more of the text: ${matches.map((x) => `"${x.m}"`).join(", ")}` : `No memory matches "${text}".`,
      });
    }
    const result = await removeMemory(memory.paths[matches[0]!.scope], matches[0]!.m);
    addMessage("error" in result ? { role: "system", isError: true, text: result.error } : { role: "system", text: `Forgot: ${result.removed}` });
  };

  const handleSubmit = (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput("");
    setFollowKey((n) => n + 1);
    if (viewing) openView(null);
    setHistory((prev) => (prev.at(-1) === text ? prev : [...prev, text]));

    if (!isCommand(text)) {
      void send(text);
      return;
    }
    const action = runCommand(text, {
      config,
      configPath: shortenHome(store.path),
      skills,
      skillProblems,
      agents,
      agentProblems,
      usage: { totals, last: usage, contextLength },
      trajectoriesPath: trajectories && shortenHome(join(trajectories.dir, projectKey(root))),
      mcp: { servers: mcp?.status() ?? [], problems: mcpProblems },
    });
    switch (action.type) {
      case "print":
        addMessage({ role: "system", text: action.text, isError: action.isError, markdown: action.markdown });
        break;
      case "clear":
        clearTranscript();
        break;
      case "setup":
        setSetupMode("reconfigure");
        break;
      case "thinking":
        void saveConfig(
          { ...(file ?? { provider: config.provider }), thinking: action.on },
          action.on
            ? "Thinking on: models may reason before answering (slower, often better)."
            : "Thinking off: models answer directly.",
        );
        break;
      case "memory":
        void showMemory();
        break;
      case "remember":
        void rememberNote(action.scope, action.text);
        break;
      case "forget":
        void forgetNote(action.text);
        break;
      case "compact":
        void compact(action.focus, false);
        break;
      case "resume":
        void openPicker();
        break;
      case "skill":
        void send(text, skillMessage(action.skill, action.args));
        break;
      case "sandbox":
        void saveConfig(
          { ...(file ?? { provider: config.provider }), sandbox: action.on },
          action.on
            ? "Sandbox on: bash commands run in bubblewrap."
            : "Sandbox off: bash commands run directly on your system (each still needs your approval).",
        );
        break;
      case "trajectories":
        void saveConfig({ ...(file ?? { provider: config.provider }), trajectories: action.on }, `Trajectories ${trajectoriesStatus({ ...config, trajectories: action.on })}`);
        break;
      case "feedback":
        rateLastTurn(action);
        break;
      case "mcp-trust":
        void trustMcp();
        break;
      case "yolo":
        void saveConfig({ ...(file ?? { provider: config.provider }), yolo: action.on }, yoloStatus({ ...config, yolo: action.on }));
        break;
      case "model":
        if (action.id) void completeSetup({ ...(file ?? { provider: config.provider }), model: action.id });
        else setSetupMode("model");
        break;
      case "exit":
        exit();
        break;
    }
  };

  /** /mcp trust: the project's servers the user hasn't trusted yet, trusted (for this exact config) and started. */
  const trustMcp = async () => {
    const waiting = mcp?.untrusted() ?? [];
    if (!mcp || waiting.length === 0) {
      addMessage({ role: "system", text: "No MCP servers are waiting to be trusted (/mcp lists them)." });
      return;
    }
    addMessage({ role: "system", text: `Starting ${waiting.map((s) => s.name).join(", ")}…` });
    try {
      const started = await mcp.trustAll();
      const lines = started.map((s) => (s.state === "connected" ? `${s.name}: connected · ${s.tools.length} tools` : `${s.name}: failed: ${s.error}`));
      addMessage({ role: "system", text: lines.join("\n"), isError: started.some((s) => s.state !== "connected") });
    } catch (err) {
      addMessage({ role: "system", text: `Couldn't trust the servers: ${(err as Error).message}`, isError: true });
    }
  };

  /** /good, /bad, /label: feedback on the latest turn of this session, in its trajectory. */
  const rateLastTurn = ({ score, note, labels }: Extract<CommandAction, { type: "feedback" }>) => {
    const log = trajectory();
    const turn = lastTurn.current;
    if (!log) {
      addMessage({ role: "system", text: "Trajectory logging is off, so there's nothing to rate (/trajectories on).", isError: true });
    } else if (!turn || turn.session !== log.session) {
      addMessage({ role: "system", text: "Nothing to rate yet: ratings apply to the last turn of this conversation.", isError: true });
    } else {
      log.write({ type: "feedback", turn: turn.id, score, source: "explicit", ...(labels ? { labels } : {}), ...(note ? { note } : {}) });
      const what = labels ? `Labeled the last turn: ${labels.join(", ")}` : `Rated the last turn: ${score > 0 ? "good" : "bad"}`;
      addMessage({ role: "system", text: `${what}${note ? ` (${note})` : ""}.` });
    }
  };

  const saveConfig = async (next: FileConfig, notice: string) => {
    try {
      await store.save(next);
      setFile(next);
      setSetupMode(null);
      addMessage({ role: "system", text: notice });
    } catch (err) {
      addMessage({ role: "system", text: `Could not save config: ${(err as Error).message}`, isError: true });
    }
  };

  const completeSetup = (next: FileConfig) => {
    const label = PRESETS[next.provider ?? "openrouter"].label;
    return saveConfig(next, `Saved to ${shortenHome(store.path)} · ${label} · ${next.model}`);
  };

  // The picker lists models for whichever provider is being chosen. A custom
  // endpoint (baseUrl) only applies to the provider it was saved with.
  const loadModelsFor = useCallback(
    (p: ProviderId) => loadModels(resolveConfig({ provider: p, baseUrl: p === file?.provider ? file.baseUrl : undefined }, env)),
    [loadModels, file, env],
  );

  // On first run there is nothing to go back to, so cancelling setup quits.
  const cancelSetup = () => (setupMode === "first-run" ? exit() : setSetupMode(null));

  // Esc stops a running reply or tool, and declines any approval already
  // queued: one can join the queue just before its prompt is drawn, and must
  // not be left waiting on a stopped run. (At an approval prompt the Approval's
  // own Esc handler runs cancelAll too; doing it twice is harmless.)
  // With a subagent's view open, Esc only closes it (the run carries on).
  useInput(
    (_char, key) => {
      if (!key.escape) return;
      if (viewing) openView(null);
      else if (abortRef.current) cancelAll();
    },
    { isActive: phase === "main" && setupMode === null },
  );

  // ctrl+o: show or hide what subagents did, under their entries.
  useInput(
    (char, key) => {
      if (key.ctrl && char === "o") setShowSteps((s) => !s);
    },
    { isActive: phase === "main" && setupMode === null },
  );

  // ctrl+c: interrupt a reply → clear the prompt → ask to confirm → exit.
  // (While setup is open, Setup handles ctrl+c itself.)
  useInput(
    (char, key) => {
      if (!(key.ctrl && char === "c")) return;
      if (abortRef.current) {
        declineAll(); // pending approvals count as declined
        abortRef.current.abort();
      } else if (input) {
        setInput("");
      } else if (confirmExit) {
        exit();
      } else {
        setConfirmExit(true);
      }
    },
    { isActive: phase === "main" && setupMode === null },
  );

  useEffect(() => {
    if (!confirmExit) return;
    const timer = setTimeout(() => setConfirmExit(false), EXIT_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmExit]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Mouse selection: drag to highlight (past the top or bottom to auto-scroll),
  // release to copy. The selection store draws the highlight itself through
  // Ink's patched transformOutput/repaint, so a drag doesn't re-render React.
  useEffect(() => {
    const onMouse = (event: MouseEvent) => {
      switch (event.type) {
        case "press":
          selection.press({ x: event.x, y: event.y });
          break;
        case "drag":
          selection.drag({ x: event.x, y: event.y });
          break;
        case "release": {
          const text = selection.release();
          if (!text) {
            // A click: on a subagent's entry, open its view.
            const row = viewingRef.current ? null : selection.rowAt({ x: event.x, y: event.y });
            const id = row === null ? null : agentEntryAt(row, agentEntries.current);
            if (!id) break;
            if (agentLogs.current.has(id)) openView(id);
            else setNotice("Only this session's subagents can be opened (ctrl+o shows the steps)");
            break;
          }
          void copy(text).then((how) =>
            setNotice(how === "osc52" ? `Sent ${text.length} chars to the terminal clipboard` : `Copied ${text.length} chars`),
          );
          break;
        }
        case "scroll":
          break; // the highlight is attached to the text, so it scrolls along
      }
    };
    mouse.on("event", onMouse);
    return () => {
      mouse.off("event", onMouse);
    };
  }, [copy, openView]);

  // Typing anything clears the highlight, like in a terminal.
  useInput(() => selection.clear(), { isActive: phase === "main" });

  // Save the session once a turn is over (not mid-run), shortly after things settle.
  useEffect(() => {
    if (!sessions || busy) return;
    const timer = setTimeout(() => {
      const transcript = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
      const { provider: providerId, model } = configRef.current;
      sessionRef.current = { ...sessionRef.current, provider: providerId, model, conversation: [...conversation.current], transcript, totals };
      void sessions.save(sessionRef.current).catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  }, [sessions, busy, items, totals]);

  /** Brings back a saved session: both histories, its cost, and it keeps saving to the same file. */
  const restore = useCallback(
    (session: Session) => {
      selection.reset();
      agentLogs.current.clear();
      setViewing(null);
      sessionRef.current = session;
      conversation.current = [...session.conversation];
      nextId.current = Math.max(0, ...session.transcript.map((m) => m.id)) + 1;
      setTotals(session.totals);
      setUsage(null);
      const switched = session.model !== configRef.current.model ? ` (it used ${session.model}; continuing with ${configRef.current.model})` : "";
      setItems([
        { kind: "welcome", id: "welcome-0" },
        ...session.transcript.map((message) => ({ kind: "message" as const, id: `msg-${message.id}`, message })),
      ]);
      addMessage({ role: "system", text: `Resumed a session from ${timeAgo(session.updatedAt)}${switched}.` });
      setFollowKey((n) => n + 1);
    },
    [addMessage],
  );

  const openPicker = useCallback(async () => {
    if (!sessions) return;
    const list = (await sessions.list(root)).filter((s) => s.id !== sessionRef.current.id);
    if (list.length === 0) addMessage({ role: "system", text: "No saved sessions for this project yet." });
    else setPicker(list);
  }, [sessions, root, addMessage]);

  const pickSession = useCallback(
    async (id: string) => {
      setPicker(null);
      const session = await sessions?.load(root, id);
      if (session) restore(session);
      else addMessage({ role: "system", isError: true, text: "That session couldn't be loaded." });
    },
    [sessions, root, restore, addMessage],
  );

  // marv -c / marv -r
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !resume || !sessions || phase !== "main") return;
    resumed.current = true;
    if (resume === "pick") void openPicker();
    else
      void sessions.latest(root).then((session) =>
        session ? restore(session) : addMessage({ role: "system", text: "No saved session to continue in this project." }),
      );
  }, [resume, sessions, phase, root, restore, openPicker, addMessage]);

  // Skills that couldn't be loaded are reported once, not silently skipped.
  useEffect(() => {
    if (skillProblems.length === 0) return;
    const count = skillProblems.length;
    addMessage({ role: "system", isError: true, text: `${count} skill${count === 1 ? "" : "s"} couldn't be loaded (see /skills):\n${skillProblems.join("\n")}` });
  }, [skillProblems, addMessage]);

  // MCP: config problems right away; once the servers have started, any that failed, and a project's servers
  // waiting to be trusted (they don't start until then).
  useEffect(() => {
    if (mcpProblems.length) addMessage({ role: "system", isError: true, text: `MCP config problems (see /mcp):\n${mcpProblems.join("\n")}` });
    if (!mcp) return;
    let cancelled = false;
    void mcp.ready.then(() => {
      if (cancelled) return;
      const status = mcp.status();
      const failed = status.filter((s) => s.state === "failed");
      if (failed.length) {
        addMessage({ role: "system", isError: true, text: `Couldn't start ${failed.map((s) => `MCP server ${s.name}: ${s.error}`).join("; ")} (see /mcp).` });
      }
      const waiting = status.filter((s) => s.state === "untrusted");
      if (waiting.length) {
        addMessage({
          role: "system",
          text: `This project's .mcp.json lists MCP servers you haven't trusted yet: ${waiting.map((s) => `${s.name} (${s.target})`).join(", ")}. They'd run with your permissions, outside the sandbox. /mcp trust starts them.`,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [mcp, mcpProblems, addMessage]);

  // Agent files that couldn't be loaded, likewise.
  useEffect(() => {
    if (agentProblems.length === 0) return;
    const count = agentProblems.length;
    addMessage({ role: "system", isError: true, text: `${count} agent file${count === 1 ? "" : "s"} couldn't be loaded (see /agents):\n${agentProblems.join("\n")}` });
  }, [agentProblems, addMessage]);

  const finishSplash = useCallback(() => setPhase("main"), []);

  // Marv runs in the alternate screen (see cli.tsx), so the root fills the
  // terminal: the transcript takes the leftover height and scrolls, and the
  // prompt and status bar stay pinned to the bottom.
  if (phase === "splash") {
    return (
      <Box height={rows} width={columns} justifyContent="center" alignItems="center">
        <Splash version={version} cwd={cwd} durationMs={splashMs} onDone={finishSplash} />
      </Box>
    );
  }

  const view = viewing ? agentLogs.current.get(viewing) : undefined;

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <ScrollView followKey={followKey} isActive={setupMode === null} onViewport={selection.setViewport} hidden={view !== undefined}>
        <Transcript
          items={items}
          version={version}
          cwd={cwd}
          instructions={Boolean(instructions)}
          skills={skills.length}
          memories={memories ? memories.personal.length + memories.project.length : 0}
          mcpServers={mcp?.status().length ?? 0}
          showSteps={showSteps}
          onAgentRef={onAgentRef}
        />

        {streaming !== null &&
          (streaming === "" ? (
            toolsRunning === 0 && <ThinkingView thought={thinking} label={compacting ? "Compacting the conversation…" : undefined} />
          ) : (
            <MessageView message={{ role: "assistant", text: streaming }} streaming />
          ))}
      </ScrollView>

      {view && <AgentViewHeader log={view} />}
      {view && (
        <ScrollView key={viewing} isActive={setupMode === null} onViewport={selection.setViewport}>
          <AgentView log={view} version={logVersion} />
        </ScrollView>
      )}

      <Box flexDirection="column" flexShrink={0}>
        {picker && !setupMode && !approval ? (
          <SessionPicker sessions={picker} onPick={(id) => void pickSession(id)} onCancel={() => setPicker(null)} />
        ) : approval && !setupMode ? (
          <>
            <Approval
              key={approval.head.id}
              request={approval.head.request}
              waiting={approval.waiting}
              onDecide={decide}
              onCancel={cancelAll}
              escapeCancels={!view}
            />
            <StatusBar model={provider.name} cwd={cwd} confirmExit={false} notice={notice} busy agents={agentsRunning} yolo={config.yolo} viewing={Boolean(view)} />
          </>
        ) : setupMode ? (
          <Setup
            initial={file}
            env={env}
            loadModels={loadModelsFor}
            startStep={setupMode === "model" ? "model" : "provider"}
            onComplete={completeSetup}
            onCancel={cancelSetup}
          />
        ) : (
          <>
            <PromptInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              history={history}
              busy={busy}
              commands={menu}
            />
            <StatusBar
              model={provider.name}
              cwd={cwd}
              usage={[usage && formatUsage(usage, contextLength), costText(totals)].filter(Boolean).join(" · ") || undefined}
              confirmExit={confirmExit}
              notice={notice}
              busy={busy}
              agents={agentsRunning}
              yolo={config.yolo}
              viewing={Boolean(view)}
            />
          </>
        )}
      </Box>
    </Box>
  );
}
