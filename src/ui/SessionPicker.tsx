import { Box, Text, useInput } from "ink";
import { timeAgo, type SessionSummary } from "../sessions.ts";
import { Select } from "./Select.tsx";
import { theme } from "./theme.ts";

const MAX_SHOWN = 15;

/** /resume: pick one of this project's saved sessions, newest first. */
export function SessionPicker({
  sessions,
  onPick,
  onCancel,
}: {
  sessions: SessionSummary[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) onCancel();
  });
  const shown = sessions.slice(0, MAX_SHOWN);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>Resume a session</Text>
      <Box marginTop={1}>
        <Select
          items={shown.map((s) => ({
            value: s.id,
            label: s.title,
            hint: `${timeAgo(s.updatedAt)} · ${s.messages} message${s.messages === 1 ? "" : "s"} · ${s.model}`,
          }))}
          onSelect={onPick}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>
          ↑/↓ to move · Enter to resume · Esc to cancel{sessions.length > MAX_SHOWN ? ` · ${MAX_SHOWN} most recent shown` : ""}
        </Text>
      </Box>
    </Box>
  );
}
