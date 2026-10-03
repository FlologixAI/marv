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
      : "/help for commands · ctrl+c to exit";

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text color={confirmExit ? theme.warning : theme.dim}>{hint}</Text>
      <Text color={theme.dim}>
        {model} · {cwd}
      </Text>
    </Box>
  );
}
