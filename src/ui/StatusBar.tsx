import { Box, Text } from "ink";
import type { Usage } from "../provider/types.ts";
import { theme } from "./theme.ts";

const tokens = (n: number) =>
  n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(n / 1000)}k`;

/**
 * The latest request's size: against the context window when we know it
 * (Ollama), plus how much the provider served from its prompt cache when it
 * reports that (OpenRouter).
 */
export function formatUsage(usage: Usage, contextLength?: number): string {
  const used = usage.promptTokens + usage.completionTokens;
  const size = contextLength ? `${tokens(used)}/${tokens(contextLength)} ctx` : `${tokens(usage.promptTokens)} tokens`;
  if (usage.cachedTokens === undefined || usage.promptTokens === 0) return size;
  return `${size} · ${Math.round((100 * usage.cachedTokens) / usage.promptTokens)}% cached`;
}

interface Props {
  model: string;
  cwd: string;
  /** Set after one ctrl+c on an empty prompt. */
  confirmExit: boolean;
  /** A short-lived message, e.g. after copying a selection. */
  notice?: string | null;
  /** From formatUsage(), once a request has been made. */
  usage?: string;
  busy: boolean;
}

export function StatusBar({ model, cwd, usage, confirmExit, notice, busy }: Props) {
  const hint = confirmExit
    ? "Press ctrl+c again to exit"
    : notice
      ? notice
      : busy
      ? "ctrl+c to interrupt"
      : "/help · PgUp/PgDn to scroll · ctrl+c to exit";

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box flexShrink={0} marginRight={2}>
        <Text color={confirmExit ? theme.warning : theme.dim}>{hint}</Text>
      </Box>
      {/* On a narrow terminal the model/cwd side gets cut off, not the hint. */}
      <Text color={theme.dim} wrap="truncate-start">
        {usage && `${usage} · `}
        {model} · {cwd}
      </Text>
    </Box>
  );
}
