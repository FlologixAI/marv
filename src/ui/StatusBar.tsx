import { Box, Text } from "ink";
import { theme } from "./theme.ts";

interface Props {
  model: string;
  cwd: string;
  /** Set after one ctrl+c on an empty prompt. */
  confirmExit: boolean;
  busy: boolean;
}

export function StatusBar({ model, cwd, confirmExit, busy }: Props) {
  const hint = confirmExit
    ? "Press ctrl+c again to exit"
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
        {model} · {cwd}
      </Text>
    </Box>
  );
}
