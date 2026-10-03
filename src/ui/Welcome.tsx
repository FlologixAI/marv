import { Box, Text } from "ink";
import { Bot } from "./Bot.tsx";
import { theme } from "./theme.ts";

// The banner at the top of the session: the ekko bot, with the text lined up
// beside its head (the antenna row sits above the text).
export function Welcome({ version, cwd }: { version: string; cwd: string }) {
  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={2} marginBottom={1} gap={3}>
      <Bot />
      <Box flexDirection="column" justifyContent="flex-end">
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
