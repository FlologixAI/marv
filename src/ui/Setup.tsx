import { useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { maskKey, PRESETS, type Env, type FileConfig, type ProviderId } from "../config/config.ts";
import type { ModelInfo } from "../provider/models.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { Select } from "./Select.tsx";
import { theme } from "./theme.ts";

type Step = "provider" | "model" | "apiKey";

interface Props {
  /** The current file config when re-running via /setup or /model; null on first run. */
  initial: FileConfig | null;
  /** Checked for provider keys (e.g. OPENROUTER_API_KEY); a key there skips the key step. */
  env: Env;
  loadModels: (provider: ProviderId) => Promise<ModelInfo[]>;
  /** "model" is the /model command: just pick a model for the current provider. */
  startStep?: "provider" | "model";
  onComplete: (config: FileConfig) => void;
  onCancel: () => void;
}

const PROVIDER_ITEMS = [
  { value: "openrouter", label: "OpenRouter", hint: "hundreds of cloud models, one API key" },
  { value: "ollama", label: "Ollama", hint: "models running on this machine, free" },
] as const;

/** Drops undefined fields so the saved JSON stays tidy. */
const tidy = (config: FileConfig): FileConfig =>
  Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) as FileConfig;

// A small wizard: each step stores its answer and decides which step comes next.
export function Setup({ initial, env, loadModels, startStep = "provider", onComplete, onCancel }: Props) {
  const [step, setStep] = useState<Step>(startStep);
  const [provider, setProvider] = useState<ProviderId>(initial?.provider ?? "openrouter");
  const [model, setModel] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) onCancel();
  });

  const preset = PRESETS[provider];
  const envKey = preset.keyEnv ? env[preset.keyEnv]?.trim() || undefined : undefined;
  const needsKeyStep = Boolean(preset.keyEnv) && !envKey;
  const sameProvider = provider === initial?.provider;

  const finish = (patch: Partial<FileConfig>) =>
    onComplete(
      tidy({
        provider,
        model,
        apiKey: initial?.apiKey,
        // A custom endpoint belongs to the provider it was set for.
        baseUrl: sameProvider ? initial?.baseUrl : undefined,
        ...patch,
      }),
    );

  const chooseProvider = (value: ProviderId) => {
    setProvider(value);
    setStep("model");
  };

  const chooseModel = (value: string) => {
    setModel(value);
    if (needsKeyStep && !(startStep === "model" && initial?.apiKey)) setStep("apiKey");
    else finish({ model: value });
  };

  const submitKey = (raw: string) => {
    const value = raw.trim();
    if (!value && initial?.apiKey) return finish({}); // Enter on empty keeps the saved key
    if (!value) return setError("Paste your API key, or press Esc to cancel.");
    if (/\s/.test(value)) return setError("That doesn't look like a key (it contains spaces).");
    finish({ apiKey: value });
  };

  // Stable per provider, so the picker fetches once rather than on every render.
  const load = useCallback(() => loadModels(provider), [loadModels, provider]);

  const steps: Step[] = ["provider", "model", ...(needsKeyStep ? (["apiKey"] as const) : [])];
  const title = startStep === "model" ? `Switch ${preset.label} model` : "Ekko setup";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text>
        <Text bold color={theme.accent}>
          {title}
        </Text>
        {startStep === "provider" && (
          <Text color={theme.dim}>
            {"  "}step {steps.indexOf(step) + 1}
            {/* The total depends on the provider, so it's only known after step 1. */}
            {step !== "provider" && ` of ${steps.length}`}
          </Text>
        )}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {step === "provider" && (
          <>
            <Text>Which AI provider should Ekko use?</Text>
            <Select items={PROVIDER_ITEMS} initialValue={provider} onSelect={chooseProvider} />
          </>
        )}

        {step === "model" && (
          <>
            <Text>Which model?</Text>
            <ModelPicker
              load={load}
              initialValue={sameProvider && initial?.model ? initial.model : preset.defaultModel}
              onSelect={chooseModel}
            />
            {envKey && (
              <Text color={theme.dim}>
                Using {preset.keyEnv} from your environment ({maskKey(envKey)}).
              </Text>
            )}
          </>
        )}

        {step === "apiKey" && (
          <>
            <Text>Paste your {preset.label} API key:</Text>
            <Text color={theme.dim}>Get one at {preset.keyUrl}. It's saved to ~/.ekko/config.json, readable only by you.</Text>
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
