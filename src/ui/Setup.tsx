import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { DEFAULT_MODEL, maskKey, MODELS, type FileConfig, type ProviderId } from "../config/config.ts";
import { Select } from "./Select.tsx";
import { theme } from "./theme.ts";

type Step = "provider" | "model" | "apiKey";

interface Props {
  /** The current file config when re-running via /setup; null on first run. */
  initial: FileConfig | null;
  /** If ANTHROPIC_API_KEY is set we use it and skip asking for a key. */
  envApiKey?: string;
  onComplete: (config: FileConfig) => void;
  onCancel: () => void;
}

const PROVIDER_ITEMS = [
  { value: "anthropic", label: "Anthropic (Claude)", hint: "needs an API key" },
  { value: "echo", label: "Echo", hint: "offline test mode, repeats what you type" },
] as const;

// A small wizard: each step stores its answer and decides which step comes next.
export function Setup({ initial, envApiKey, onComplete, onCancel }: Props) {
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<ProviderId>(initial?.provider ?? "anthropic");
  const [model, setModel] = useState(initial?.model ?? DEFAULT_MODEL);
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) onCancel();
  });

  const finish = (patch: Partial<FileConfig>) => onComplete({ provider, model, apiKey: initial?.apiKey, ...patch });

  const chooseProvider = (value: ProviderId) => {
    setProvider(value);
    if (value === "echo") onComplete({ provider: value, model, apiKey: initial?.apiKey });
    else setStep("model");
  };

  const chooseModel = (value: string) => {
    setModel(value);
    if (envApiKey) finish({ model: value });
    else setStep("apiKey");
  };

  const submitKey = (raw: string) => {
    const value = raw.trim();
    if (!value && initial?.apiKey) return finish({}); // Enter on empty keeps the saved key
    if (!value) return setError("Paste your API key, or press Esc to cancel.");
    if (/\s/.test(value)) return setError("That doesn't look like a key (it contains spaces).");
    finish({ apiKey: value });
  };

  const stepNumber = { provider: 1, model: 2, apiKey: 3 }[step];
  const totalSteps = envApiKey ? 2 : 3;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text>
        <Text bold color={theme.accent}>
          ekko setup
        </Text>
        <Text color={theme.dim}>
          {"  "}step {stepNumber} of {provider === "echo" ? 1 : totalSteps}
        </Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        {step === "provider" && (
          <>
            <Text>Which AI provider should ekko use?</Text>
            <Select items={PROVIDER_ITEMS} initialValue={provider} onSelect={chooseProvider} />
          </>
        )}

        {step === "model" && (
          <>
            <Text>Which model?</Text>
            <Select
              items={MODELS.map((m) => ({ value: m.id, label: m.label, hint: m.hint }))}
              initialValue={model}
              onSelect={chooseModel}
            />
            {envApiKey && <Text color={theme.dim}>Using ANTHROPIC_API_KEY from your environment ({maskKey(envApiKey)}).</Text>}
          </>
        )}

        {step === "apiKey" && (
          <>
            <Text>Paste your Anthropic API key:</Text>
            <Text color={theme.dim}>Get one at console.anthropic.com. It's saved to ~/.ekko/config.json, readable only by you.</Text>
            {initial?.apiKey && <Text color={theme.dim}>Press Enter to keep the current key ({maskKey(initial.apiKey)}).</Text>}
            <Box>
              <Text color={theme.accent}>{"> "}</Text>
              <TextInput
                value={keyInput}
                mask="*"
                onChange={(v) => {
                  setKeyInput(v);
                  setError(null);
                }}
                onSubmit={submitKey}
              />
            </Box>
            {error && <Text color={theme.error}>{error}</Text>}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          {step === "apiKey" ? "Enter to save" : "↑/↓ to move · Enter to choose"} · Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
