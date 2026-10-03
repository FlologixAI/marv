import { Box, Text } from "ink";
import { Martian } from "./Martian.tsx";
import { theme } from "./theme.ts";

// The banner at the top of the session: the ekko martian, with the
// welcome text centered beside it.
export function Welcome({ version, cwd, animate = true }: { version: string; cwd: string; animate?: boolean }) {
  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={2} marginBottom={1} gap={3}>
      <Martian animate={animate} />
      <Box flexDirection="column" justifyContent="center">
        <Text>
          <Text bold>Welcome to ekko</Text>
          <Text color={theme.dim}> v{version}</Text>
        </Text>
        <Text color={theme.dim}>/help for commands</Text>
        <Text color={theme.dim}>cwd: {cwd}</Text>
      </Box>
    </Box>
  );
}
