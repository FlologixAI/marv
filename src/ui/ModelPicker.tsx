import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { formatPrice, type ModelInfo } from "../provider/models.ts";
import { theme } from "./theme.ts";

const VISIBLE = 8;

interface Props {
  /** Fetches the provider's models (OpenRouter has hundreds, Ollama what you've pulled). */
  load: () => Promise<ModelInfo[]>;
  initialValue?: string;
  onSelect: (id: string) => void;
}

/** Every space-separated term must appear in the id: "claude sonnet" matches "anthropic/claude-sonnet-5.5". */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return models.filter((m) => terms.every((term) => m.id.toLowerCase().includes(term)));
}

// Type to filter, ↑/↓ to move, Enter to choose. If nothing matches (or the
// list couldn't load), Enter uses what you typed as the model ID.
export function ModelPicker({ load, initialValue, onSelect }: Props) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (list) => {
        if (cancelled) return;
        setModels(list);
        setIndex(Math.max(0, list.findIndex((m) => m.id === initialValue)));
      },
      (err: Error) => !cancelled && setLoadError(err.message),
    );
    return () => {
      cancelled = true;
    };
  }, [load, initialValue]);

  const matches = filterModels(models ?? [], query);
  const custom = query.trim();

  useInput((_input, key) => {
    if (matches.length === 0) return;
    if (key.upArrow) setIndex((i) => (i - 1 + matches.length) % matches.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % matches.length);
  });

  const submit = () => {
    const chosen = matches[index];
    if (chosen) onSelect(chosen.id);
    else if (custom) onSelect(custom);
  };

  // Scroll the visible window so the highlighted row stays in view.
  const start = Math.min(Math.max(0, index - Math.floor(VISIBLE / 2)), Math.max(0, matches.length - VISIBLE));
  const shown = matches.slice(start, start + VISIBLE);
  const idWidth = Math.min(44, Math.max(0, ...shown.map((m) => m.id.length)));

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.accent}>{"> "}</Text>
        <TextInput
          value={query}
          onChange={(value) => {
            setQuery(value);
            setIndex(0);
          }}
          onSubmit={submit}
          placeholder="type to filter, e.g. sonnet, deepseek, qwen"
        />
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {models === null && !loadError && <Text color={theme.dim}>Loading models…</Text>}
        {loadError && (
          <Text color={theme.error}>
            Couldn't load models: {loadError}
            <Text color={theme.dim}> · type a model ID and press Enter</Text>
          </Text>
        )}
        {shown.map((model) => {
          const active = model === matches[index];
          return (
            <Text key={model.id} color={active ? theme.accent : undefined} wrap="truncate-end">
              {active ? "❯ " : "  "}
              {model.id.padEnd(idWidth)}
              <Text color={theme.dim}>  {formatPrice(model)}</Text>
              {model.tools === false && <Text color={theme.warning}>  no tool support</Text>}
            </Text>
          );
        })}
        {models !== null && matches.length === 0 && custom && (
          <Text color={theme.dim}>No matches. Press Enter to use "{custom}" as the model ID.</Text>
        )}
      </Box>

      {models !== null && models.length > 0 && (
        <Text color={theme.dim}>
          {matches.length} of {models.length} models
          {models.some((m) => m.priceIn !== undefined) && " · prices per million tokens, in / out"}
        </Text>
      )}
    </Box>
  );
}
