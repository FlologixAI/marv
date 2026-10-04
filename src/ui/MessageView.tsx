import { Box, Text } from "ink";
import type { Message } from "../types.ts";
import { theme } from "./theme.ts";

/**
 * The 2-column marker in front of a message ("● ", "> "). A fixed-width box
 * rather than a Text with a trailing space: Ink lays out "● " as 1 column wide
 * but draws it as 2, so the text beside it would wrap one column too wide and
 * lose a character at every line break.
 */
function Gutter({ mark, color }: { mark: string; color: string }) {
  return (
    <Box width={2} flexShrink={0}>
      <Text color={color}>{mark}</Text>
    </Box>
  );
}

// How one transcript entry looks. Used both for finished messages
// and for the assistant message that is still streaming in.
export function MessageView({ message }: { message: Pick<Message, "role" | "text" | "isError"> }) {
  switch (message.role) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Gutter mark=">" color={theme.user} />
          <Box flexShrink={1}>
            <Text color={theme.user}>{message.text}</Text>
          </Box>
        </Box>
      );
    case "assistant":
      return (
        <Box marginBottom={1}>
          <Gutter mark="●" color={theme.assistant} />
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
