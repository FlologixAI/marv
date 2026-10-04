import { memo } from "react";
import { Box, Text } from "ink";
import type { Message } from "../types.ts";
import { Markdown } from "./Markdown.tsx";
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
// memo: when the transcript changes (a new message, a tool line updating),
// only the entries whose message object changed re-render, not all of them.
export const MessageView = memo(function MessageView({
  message,
  streaming = false,
}: {
  message: Pick<Message, "role" | "text" | "isError" | "tool" | "markdown">;
  /** The assistant reply still coming in (parsed incrementally). */
  streaming?: boolean;
}) {
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
          <Box flexShrink={1} flexDirection="column">
            <Markdown text={message.text} streaming={streaming} />
          </Box>
        </Box>
      );
    case "tool": {
      // ● read_file src/app.tsx
      //   ⎿ 250 lines
      const tool = message.tool!;
      const failed = tool.status === "error";
      const declined = tool.status === "declined";
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text wrap="truncate-end">
            <Text color={failed ? theme.error : theme.accent}>{"● "}</Text>
            <Text bold>{message.text}</Text>
            <Text color={theme.dim}> {tool.label}</Text>
          </Text>
          <Text color={failed ? theme.error : declined ? theme.warning : theme.dim} wrap="truncate-end">
            {"  ⎿ "}
            {tool.status === "running" ? "running…" : tool.summary}
          </Text>
        </Box>
      );
    }
    case "system":
      if (message.markdown) {
        return (
          <Box marginBottom={1} flexDirection="column">
            <Markdown text={message.text} />
          </Box>
        );
      }
      return (
        <Box marginBottom={1}>
          <Text color={message.isError ? theme.error : theme.dim}>{message.text}</Text>
        </Box>
      );
  }
});
