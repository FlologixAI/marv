import { Box, Text } from "ink";
import { theme } from "./theme.ts";

// The banner at the top of the session. It is printed into the
// transcript (scrollback), so it stays put as the conversation grows.
export function Welcome({ version, cwd }: { version: string; cwd: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text>
        <Text color={theme.accent}>✻ </Text>
        <Text bold>Welcome to ekko</Text>
        <Text color={theme.dim}> v{version}</Text>
      </Text>
      <Text color={theme.dim}>/help for commands</Text>
      <Text color={theme.dim}>cwd: {cwd}</Text>
    </Box>
  );
}
