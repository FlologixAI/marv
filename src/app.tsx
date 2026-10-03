import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import Spinner from "ink-spinner";
import { isCommand, runCommand } from "./commands/index.ts";
import { needsSetup, resolveConfig, type Config, type ConfigStore, type Env, type FileConfig } from "./config/config.ts";
import { shortenHome } from "./paths.ts";
import { createProvider } from "./provider/index.ts";
import type { ChatTurn, Provider } from "./provider/types.ts";
import type { Message } from "./types.ts";
import { MessageView } from "./ui/MessageView.tsx";
import { PromptInput } from "./ui/PromptInput.tsx";
import { ScrollView } from "./ui/ScrollView.tsx";
import { Setup } from "./ui/Setup.tsx";
import { Splash } from "./ui/Splash.tsx";
import { StatusBar } from "./ui/StatusBar.tsx";
import { theme } from "./ui/theme.ts";
import { Transcript, type TranscriptItem } from "./ui/Transcript.tsx";

const EXIT_CONFIRM_MS = 1500;

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
}

type SetupMode = "first-run" | "reconfigure" | null;

export function App({ store, initialFile, env, version, cwd, splashMs = 1200, makeProvider = createProvider }: Props) {
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
  const [confirmExit, setConfirmExit] = useState(false);
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
      try {
        for await (const event of provider.stream(conversation.current, controller.signal)) {
          if (event.type === "text_delta") {
            reply += event.text;
            setStreaming(reply);
          } else if (event.type === "error") {
            addMessage({ role: "system", text: event.message, isError: true });
          }
        }
      } catch (err) {
        addMessage({ role: "system", text: `Error: ${(err as Error).message}`, isError: true });
      } finally {
        if (reply) {
          addMessage({ role: "assistant", text: reply });
          conversation.current.push({ role: "assistant", text: reply });
        }
        if (controller.signal.aborted) addMessage({ role: "system", text: "Interrupted." });
        abortRef.current = null;
        setStreaming(null);
      }
    },
    [provider, addMessage],
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
      case "exit":
        exit();
        break;
    }
  };

  const completeSetup = async (next: FileConfig) => {
    try {
      await store.save(next);
      setFile(next);
      setSetupMode(null);
      addMessage({ role: "system", text: `Saved to ${shortenHome(store.path)} · ${next.provider} · ${next.model}` });
    } catch (err) {
      addMessage({ role: "system", text: `Could not save config: ${(err as Error).message}`, isError: true });
    }
  };

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
            <Box marginBottom={1}>
              <Text color={theme.accent}>
                <Spinner type="dots" />
              </Text>
              <Text color={theme.dim}> Thinking…</Text>
            </Box>
          ) : (
            <MessageView message={{ role: "assistant", text: streaming }} />
          ))}
      </ScrollView>

      <Box flexDirection="column" flexShrink={0}>
        {setupMode ? (
          <Setup
            initial={file}
            envApiKey={config.apiKeySource === "env" ? config.apiKey : undefined}
            onComplete={completeSetup}
            onCancel={cancelSetup}
          />
        ) : (
          <>
            <PromptInput value={input} onChange={setInput} onSubmit={handleSubmit} history={history} busy={busy} />
            <StatusBar model={provider.name} cwd={cwd} confirmExit={confirmExit} busy={busy} />
          </>
        )}
      </Box>
    </Box>
  );
}
