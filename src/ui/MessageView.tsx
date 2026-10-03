import { Box, Text } from "ink";
import type { Message } from "../types.ts";
import { theme } from "./theme.ts";

// How one transcript entry looks. Used both for finished messages
// and for the assistant message that is still streaming in.
export function MessageView({ message }: { message: Pick<Message, "role" | "text" | "isError"> }) {
  switch (message.role) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Text color={theme.user}>{"> "}</Text>
          <Text color={theme.user}>{message.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginBottom={1}>
          <Text color={theme.assistant}>{"● "}</Text>
          <Box flexShrink={1}>
            <Text>{message.text}</Text>
          </Box>
        </Box>
      );
    case "system":
      return (
        <Box marginBottom={1}>
          <Text color={message.isError ? theme.error : theme.dim}>{message.text}</Text>
        </Box>
      );
  }
}
