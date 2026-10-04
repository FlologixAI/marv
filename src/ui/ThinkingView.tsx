import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { theme } from "./theme.ts";

const PREVIEW_LINES = 3;

// Shown while waiting for the reply. For thinking models it previews the tail
// of their reasoning, so a long think visibly makes progress instead of
// looking like a hang.
export function ThinkingView({ thought, label = "Thinking…" }: { thought: string; label?: string }) {
  const tail = thought
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-PREVIEW_LINES);
  const words = thought.split(/\s+/).filter(Boolean).length;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={theme.accent}>
          <Spinner type="dots" />
        </Text>
        <Text color={theme.dim}>
          {" "}
          {label}
          {words > 0 && ` (${words} words)`}
        </Text>
      </Text>
      {tail.map((line, i) => (
        <Text key={i} color={theme.dim} italic wrap="truncate-end">
          {"  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}
