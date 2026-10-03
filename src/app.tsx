import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
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
import type { ChatTurn, Provider } from "./provider/types.ts";
import { selection } from "./selection.ts";
import { systemPrompt } from "./prompt.ts";
import type { Message } from "./types.ts";
import { MessageView } from "./ui/MessageView.tsx";
import { PromptInput } from "./ui/PromptInput.tsx";
import { ScrollView } from "./ui/ScrollView.tsx";
import { Setup } from "./ui/Setup.tsx";
import { Splash } from "./ui/Splash.tsx";
import { StatusBar } from "./ui/StatusBar.tsx";
import { ThinkingView } from "./ui/ThinkingView.tsx";
import { Transcript, type TranscriptItem } from "./ui/Transcript.tsx";

const EXIT_CONFIRM_MS = 1500;
const NOTICE_MS = 2000;

interface Props {
  store: ConfigStore;
  /** The config file as loaded at startup; null on first run. */
  initialFile: FileConfig | null;
  env: Env;
  version: string;
  cwd: string;
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
  // …versus what the model sees: only real user/assistant turns.
  const conversation = useRef<ChatTurn[]>([]);

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
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
  }, []);

  const clearTranscript = useCallback(() => {
    conversation.current = [];
    setItems([{ kind: "welcome", id: "welcome-0" }]);
  }, []);

  const send = useCallback(
    async (text: string) => {
      addMessage({ role: "user", text });
      conversation.current.push({ role: "user", text });

      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming("");

      let reply = "";
      let thought = "";
      const started = Date.now();
      let thoughtMs = 0;
      try {
        const system = systemPrompt({ cwd });
        for await (const event of provider.stream(conversation.current, { system, signal: controller.signal })) {
          if (event.type === "thinking_delta") {
            thought += event.text;
            setThinking(thought);
          } else if (event.type === "text_delta") {
            if (thought && !thoughtMs) thoughtMs = Date.now() - started;
            reply += event.text;
            setStreaming(reply);
          } else if (event.type === "error") {
            addMessage({ role: "system", text: event.message, isError: true });
          }
        }
      } catch (err) {
        addMessage({ role: "system", text: `Error: ${(err as Error).message}`, isError: true });
      } finally {
        if (thought) {
          const seconds = Math.max(1, Math.round((thoughtMs || Date.now() - started) / 1000));
          addMessage({ role: "system", text: `✻ Thought for ${seconds}s` });
        }
        if (reply) {
          addMessage({ role: "assistant", text: reply });
          conversation.current.push({ role: "assistant", text: reply });
        }
        if (controller.signal.aborted) addMessage({ role: "system", text: "Interrupted." });
        abortRef.current = null;
        setStreaming(null);
        setThinking("");
      }
    },
    [provider, addMessage, cwd],
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

  // Mouse selection: drag to highlight, release to copy. The highlight is drawn
  // by selection.transformOutput (hooked into Ink in cli.tsx); subscribing here
  // re-renders on every change so Ink produces a frame with the new highlight.
  useSyncExternalStore(selection.subscribe, () => selection.current);
  useEffect(() => {
    const onMouse = (event: MouseEvent) => {
      switch (event.type) {
        case "press":
          selection.start({ x: event.x, y: event.y });
          break;
        case "drag":
          selection.extend({ x: event.x, y: event.y });
          break;
        case "release": {
          const text = selection.text();
          if (!text) {
            selection.clear(); // just a click
            break;
          }
          void copy(text).then((how) =>
            setNotice(how === "osc52" ? `Sent ${text.length} chars to the terminal clipboard` : `Copied ${text.length} chars`),
          );
          break;
        }
        case "scroll":
          selection.clear(); // the text under the highlight is moving
          break;
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

  // ekko runs in the alternate screen (see cli.tsx), so the root fills the
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
      <ScrollView followKey={followKey} isActive={setupMode === null}>
        <Transcript items={items} version={version} cwd={cwd} />

        {streaming !== null &&
          (streaming === "" ? (
            <ThinkingView thought={thinking} />
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
            <StatusBar model={provider.name} cwd={cwd} confirmExit={confirmExit} notice={notice} busy={busy} />
          </>
        )}
      </Box>
    </Box>
  );
}
