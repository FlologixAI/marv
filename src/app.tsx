import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import { runAgent } from "./agent.ts";
import { copyToClipboard } from "./clipboard.ts";
import { commands, isCommand, runCommand } from "./commands/index.ts";
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
import { shortenHome } from "./paths.ts";
import { mouse, type MouseEvent } from "./mouse.ts";
import { createProvider } from "./provider/index.ts";
import { listModels, type ModelInfo } from "./provider/models.ts";
import type { ChatTurn, Provider, Usage } from "./provider/types.ts";
import { selection } from "./selection.ts";
import { systemPrompt } from "./prompt.ts";
import { addUsage, costText, emptyTotals, type Prices, type Totals } from "./usage.ts";
import { skillMessage, type Skill } from "./skills.ts";
import { runTool, toolSpecsFor } from "./tools/index.ts";
import type { ApprovalRequest, Decision } from "./tools/types.ts";
import type { Message } from "./types.ts";
import { Approval } from "./ui/Approval.tsx";
import { MessageView } from "./ui/MessageView.tsx";
import { PromptInput } from "./ui/PromptInput.tsx";
import { ScrollView } from "./ui/ScrollView.tsx";
import { Setup } from "./ui/Setup.tsx";
import { Splash } from "./ui/Splash.tsx";
import { formatUsage, StatusBar } from "./ui/StatusBar.tsx";
import { ThinkingView } from "./ui/ThinkingView.tsx";
import { Transcript, type TranscriptItem } from "./ui/Transcript.tsx";

const EXIT_CONFIRM_MS = 1500;
const NOTICE_MS = 2000;
/**
 * Streamed text is shown at most this often (Ink draws at most 30 frames/s
 * anyway). Updating React on every token re-parsed the whole Markdown reply
 * for frames nobody would see.
 */
const STREAM_FLUSH_MS = 33;
/** Warn once when the conversation fills this much of a known context window. */
const CONTEXT_WARNING = 0.85;

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
  // Built once per session, so they're byte-identical in every request.
  const specs = useMemo(() => toolSpecsFor({ hasSkills: skills.length > 0 }), [skills]);
  const system = useMemo(
    () => systemPrompt({ cwd, tools: specs.map((t) => t.name), instructions, skills }),
    [cwd, specs, instructions, skills],
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
  const warnedFull = useRef(false);

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  // Set while a tool runs (its transcript line shows the progress, so no "Thinking…").
  const [toolRunning, setToolRunning] = useState(false);
  // A tool waiting for the user's yes/no (shown in place of the prompt).
  const [approval, setApproval] = useState<{ request: ApprovalRequest; resolve: (d: Decision) => void } | null>(null);
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  // "Yes, don't ask again": scopes approved for the rest of this session.
  const alwaysAllowed = useRef(new Set<string>());

  const approve = useCallback(
    (request: ApprovalRequest): Promise<Decision> =>
      alwaysAllowed.current.has(request.scope.key) ? Promise.resolve("yes") : new Promise((resolve) => setApproval({ request, resolve })),
    [],
  );
  const decide = useCallback((decision: Decision) => {
    const pending = approvalRef.current;
    if (!pending) return;
    if (decision === "always") alwaysAllowed.current.add(pending.request.scope.key);
    approvalRef.current = null;
    setApproval(null);
    pending.resolve(decision);
  }, []);
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

  const updateMessage = useCallback((id: number, patch: Partial<Message>) => {
    setItems((prev) =>
      prev.map((item) => (item.kind === "message" && item.message.id === id ? { ...item, message: { ...item.message, ...patch } } : item)),
    );
  }, []);

  const clearTranscript = useCallback(() => {
    selection.reset();
    conversation.current = [];
    warnedFull.current = false;
    setUsage(null);
    setItems([{ kind: "welcome", id: "welcome-0" }]);
  }, []);

  const send = useCallback(
    // `forModel`: what the model gets, when it differs from what the user typed (a /skill).
    async (text: string, forModel = text) => {
      addMessage({ role: "user", text });
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
      const toolLines = new Map<string, number>();
      let lastUsage: Usage | null = null;
      // Tokens accumulate in `reply`/`thought` and reach React in batches.
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = () => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        setStreaming(reply);
        setThinking(thought);
      };
      const scheduleFlush = () => {
        flushTimer ??= setTimeout(flush, STREAM_FLUSH_MS);
      };

      try {
        for await (const event of runAgent({
          provider,
          history: conversation.current,
          system,
          tools: specs,
          runTool: (call) => runTool(call, { root, signal: controller.signal, approve, sandbox: config.sandbox, skills }),
          signal: controller.signal,
        })) {
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
            case "tool_start":
              flush();
              noteThought();
              setToolRunning(true);
              toolLines.set(
                event.call.id,
                addMessage({ role: "tool", text: event.call.name, tool: { label: event.label, status: "running" } }),
              );
              break;
            case "tool_end": {
              const { result } = event;
              const line = toolLines.get(event.call.id);
              const summary = result.isError ? result.output.split("\n")[0] : result.summary;
              const status = result.declined ? "declined" : result.isError ? "error" : "done";
              if (line !== undefined) updateMessage(line, { tool: { label: result.label, status, summary } });
              setToolRunning(false);
              stepStarted = Date.now();
              break;
            }
            case "usage": {
              lastUsage = event.usage;
              setUsage(event.usage);
              const local = config.provider === "ollama";
              setTotals((t) => ({ ...addUsage(t, event.usage, info?.prices), local: (t.requests === 0 || t.local) && local }));
              break;
            }
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
        if (flushTimer) clearTimeout(flushTimer);
        noteThought();
        abortRef.current = null;
        setStreaming(null);
        setToolRunning(false);
      }

      // Ollama silently drops the oldest messages once the window is full; say so before it happens.
      const window = contextLength;
      if (window && lastUsage && !warnedFull.current) {
        const used = lastUsage.promptTokens + lastUsage.completionTokens;
        if (used >= window * CONTEXT_WARNING) {
          warnedFull.current = true;
          addMessage({
            role: "system",
            isError: true,
            text: `Context is ${Math.round((100 * used) / window)}% full (${formatUsage(lastUsage, window)}). Soon the model will lose the start of the conversation; /clear starts fresh.`,
          });
        }
      }
    },
    [provider, addMessage, updateMessage, system, specs, skills, root, approve, config.sandbox, config.provider, info, contextLength],
  );

  const handleSubmit = (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput("");
    setFollowKey((n) => n + 1);
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
      usage: { totals, last: usage, contextLength },
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
      case "model":
        if (action.id) void completeSetup({ ...(file ?? { provider: config.provider }), model: action.id });
        else setSetupMode("model");
        break;
      case "exit":
        exit();
        break;
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

  // Esc stops a running reply or tool. (At an approval prompt, Esc means "no",
  // which the prompt handles, and which stops the run too.)
  useInput(
    (_char, key) => {
      if (key.escape && abortRef.current && !approvalRef.current) abortRef.current.abort();
    },
    { isActive: phase === "main" && setupMode === null },
  );

  // ctrl+c: interrupt a reply → clear the prompt → ask to confirm → exit.
  // (While setup is open, Setup handles ctrl+c itself.)
  useInput(
    (char, key) => {
      if (!(key.ctrl && char === "c")) return;
      if (abortRef.current) {
        decide("no"); // a pending approval counts as declined
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
          if (!text) break; // just a click
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
  }, [copy]);

  // Typing anything clears the highlight, like in a terminal.
  useInput(() => selection.clear(), { isActive: phase === "main" });

  // Skills that couldn't be loaded are reported once, not silently skipped.
  useEffect(() => {
    if (skillProblems.length === 0) return;
    const count = skillProblems.length;
    addMessage({ role: "system", isError: true, text: `${count} skill${count === 1 ? "" : "s"} couldn't be loaded (see /skills):\n${skillProblems.join("\n")}` });
  }, [skillProblems, addMessage]);

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

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <ScrollView followKey={followKey} isActive={setupMode === null} onViewport={selection.setViewport}>
        <Transcript items={items} version={version} cwd={cwd} instructions={Boolean(instructions)} skills={skills.length} />

        {streaming !== null &&
          (streaming === "" ? (
            !toolRunning && <ThinkingView thought={thinking} />
          ) : (
            <MessageView message={{ role: "assistant", text: streaming }} streaming />
          ))}
      </ScrollView>

      <Box flexDirection="column" flexShrink={0}>
        {approval && !setupMode ? (
          <>
            <Approval request={approval.request} onDecide={decide} />
            <StatusBar model={provider.name} cwd={cwd} confirmExit={false} notice={notice} busy />
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
            />
          </>
        )}
      </Box>
    </Box>
  );
}
