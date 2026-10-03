import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import { isCommand, runCommand } from "./commands/index.ts";
import type { ChatTurn, Provider } from "./provider/types.ts";
import type { Message } from "./types.ts";
import { MessageView } from "./ui/MessageView.tsx";
import { PromptInput } from "./ui/PromptInput.tsx";
import { Splash } from "./ui/Splash.tsx";
import { StatusBar } from "./ui/StatusBar.tsx";
import { theme } from "./ui/theme.ts";
import { Transcript, type TranscriptItem } from "./ui/Transcript.tsx";

const EXIT_CONFIRM_MS = 1500;
const CLEAR_SCREEN = "\x1b[2J\x1b[3J\x1b[H";

interface Props {
  provider: Provider;
  version: string;
  cwd: string;
  /** 0 skips the splash entirely (used by tests). */
  splashMs?: number;
}

export function App({ provider, version, cwd, splashMs = 1200 }: Props) {
  const { exit } = useApp();
  const { write } = useStdout();
  const [phase, setPhase] = useState<"splash" | "main">(splashMs > 0 ? "splash" : "main");

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
  // Bumped by /clear to remount <Static>, which otherwise remembers how many items it already printed.
  const [session, setSession] = useState(0);

  const busy = streaming !== null;

  const addMessage = useCallback((message: Omit<Message, "id">) => {
    const id = nextId.current++;
    setItems((prev) => [...prev, { kind: "message", id: `msg-${id}`, message: { id, ...message } }]);
  }, []);

  const clearTranscript = useCallback(() => {
    // <Static> output is already in the terminal, so wipe the screen itself,
    // then start a fresh transcript.
    write(CLEAR_SCREEN);
    conversation.current = [];
    setItems([{ kind: "welcome", id: "welcome-0" }]);
    setSession((n) => n + 1);
  }, [write]);

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
    setHistory((prev) => (prev.at(-1) === text ? prev : [...prev, text]));

    if (!isCommand(text)) {
      void send(text);
      return;
    }
    const action = runCommand(text);
    switch (action.type) {
      case "print":
        addMessage({ role: "system", text: action.text, isError: action.isError });
        break;
      case "clear":
        clearTranscript();
        break;
      case "exit":
        exit();
        break;
    }
  };

  // ctrl+c: interrupt a reply → clear the prompt → ask to confirm → exit.
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
    { isActive: phase === "main" },
  );

  useEffect(() => {
    if (!confirmExit) return;
    const timer = setTimeout(() => setConfirmExit(false), EXIT_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmExit]);

  const finishSplash = useCallback(() => setPhase("main"), []);

  if (phase === "splash") {
    return <Splash version={version} cwd={cwd} durationMs={splashMs} onDone={finishSplash} />;
  }

  return (
    <Box flexDirection="column">
      <Transcript key={session} items={items} version={version} cwd={cwd} />

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

      <PromptInput value={input} onChange={setInput} onSubmit={handleSubmit} history={history} busy={busy} />
      <StatusBar model={provider.name} cwd={cwd} confirmExit={confirmExit} busy={busy} />
    </Box>
  );
}
