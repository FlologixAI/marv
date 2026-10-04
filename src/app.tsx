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
import { runTool, toolSpecs } from "./tools/index.ts";
import type { Message } from "./types.ts";
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
  // Built once per session, so it's byte-identical in every request.
  const system = useMemo(() => systemPrompt({ cwd, tools: toolSpecs.map((t) => t.name), instructions }), [cwd, instructions]);
  // Token counts from the latest request, for the status bar.
  const [usage, setUsage] = useState<Usage | null>(null);
  const warnedFull = useRef(false);

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  // Set while a tool runs (its transcript line shows the progress, so no "Thinking…").
  const [toolRunning, setToolRunning] = useState(false);
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
    async (text: string) => {
      addMessage({ role: "user", text });
      conversation.current.push({ role: "user", text });

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

      try {
        for await (const event of runAgent({
          provider,
          history: conversation.current,
          system,
          tools: toolSpecs,
          runTool: (call) => runTool(call, { root, signal: controller.signal }),
          signal: controller.signal,
        })) {
          switch (event.type) {
            case "thinking_delta":
              thought += event.text;
              setThinking(thought);
              break;
            case "text_delta":
              if (thought && !thoughtMs) thoughtMs = Date.now() - stepStarted;
              reply += event.text;
              setStreaming(reply);
              break;
            case "assistant":
              noteThought();
              addMessage({ role: "assistant", text: event.text });
              reply = "";
              setStreaming("");
              break;
            case "tool_start":
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
              if (line !== undefined) updateMessage(line, { tool: { label: result.label, status: result.isError ? "error" : "done", summary } });
              setToolRunning(false);
              stepStarted = Date.now();
              break;
            }
            case "usage":
              lastUsage = event.usage;
              setUsage(event.usage);
              break;
            case "error":
              addMessage({ role: "system", text: event.message, isError: true });
              break;
            case "done":
              if (event.reason === "aborted") addMessage({ role: "system", text: "Interrupted." });
              if (event.reason === "length") addMessage({ role: "system", text: "The reply was cut off: it hit the model's output limit." });
              break;
          }
        }
      } catch (err) {
        addMessage({ role: "system", text: `Error: ${(err as Error).message}`, isError: true });
      } finally {
        noteThought();
        abortRef.current = null;
        setStreaming(null);
        setToolRunning(false);
      }

      // Ollama silently drops the oldest messages once the window is full; say so before it happens.
      const window = provider.contextLength;
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
    [provider, addMessage, updateMessage, system, root],
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
    const action = runCommand(text, { config, configPath: shortenHome(store.path) });
    switch (action.type) {
      case "print":
        addMessage({ role: "system", text: action.text, isError: action.isError });
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

  // ctrl+c: interrupt a reply → clear the prompt → ask to confirm → exit.
  // (While setup is open, Setup handles ctrl+c itself.)
  useInput(
    (char, key) => {
      if (!(key.ctrl && char === "c")) return;
      if (abortRef.current) {
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

  const finishSplash = useCallback(() => setPhase("main"), []);

  // Ekko runs in the alternate screen (see cli.tsx), so the root fills the
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
        <Transcript items={items} version={version} cwd={cwd} instructions={Boolean(instructions)} />

        {streaming !== null &&
          (streaming === "" ? (
            !toolRunning && <ThinkingView thought={thinking} />
          ) : (
            <MessageView message={{ role: "assistant", text: streaming }} />
          ))}
      </ScrollView>

      <Box flexDirection="column" flexShrink={0}>
        {setupMode ? (
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
              commands={commands}
            />
            <StatusBar
              model={provider.name}
              cwd={cwd}
              usage={usage ? formatUsage(usage, provider.contextLength) : undefined}
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
