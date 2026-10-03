import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { theme } from "./theme.ts";

export interface CommandInfo {
  name: string;
  description: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Previous submissions, oldest first. */
  history: string[];
  busy: boolean;
  /** Offered in a menu while typing a slash command. */
  commands: readonly CommandInfo[];
}

/**
 * Commands matching what's typed so far ("/se" → setup), prefix matches first.
 * Empty once there's a space, i.e. the user is typing arguments.
 */
export function matchCommands(value: string, commands: readonly CommandInfo[]): CommandInfo[] {
  const match = /^\/(\S*)$/.exec(value);
  if (!match) return [];
  const typed = match[1]!.toLowerCase();
  const prefix = commands.filter((c) => c.name.startsWith(typed));
  const other = commands.filter((c) => !c.name.startsWith(typed) && c.name.includes(typed));
  return [...prefix, ...other];
}

export function PromptInput({ value, onChange, onSubmit, history, busy, commands }: Props) {
  // -1 means "not browsing history" (editing a fresh line).
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [menuIndex, setMenuIndex] = useState(0);
  // Esc hides the menu until the text changes again.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  // TextInput keeps its own cursor and leaves it in place when we replace the
  // text from outside (history, Tab). Remounting it puts the cursor at the end.
  const [inputKey, setInputKey] = useState(0);

  const matches = matchCommands(value, commands);
  const menuOpen = !busy && matches.length > 0 && dismissedAt !== value;
  const highlighted = matches[Math.min(menuIndex, matches.length - 1)];

  const type = (next: string) => {
    setMenuIndex(0);
    onChange(next);
  };
  const replace = (next: string) => {
    type(next);
    setInputKey((k) => k + 1);
  };

  useInput((_input, key) => {
    if (menuOpen) {
      if (key.upArrow) setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
      else if (key.downArrow) setMenuIndex((i) => (i + 1) % matches.length);
      else if (key.tab && highlighted) replace(`/${highlighted.name} `);
      else if (key.escape) setDismissedAt(value);
      return;
    }

    if (key.upArrow && history.length > 0) {
      const next = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      replace(history[next]!);
    } else if (key.downArrow && historyIndex !== -1) {
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(-1);
        replace("");
      } else {
        setHistoryIndex(next);
        replace(history[next]!);
      }
    }
  });

  const handleSubmit = (text: string) => {
    setHistoryIndex(-1);
    setDismissedAt(null);
    // With the menu open, Enter runs the highlighted command ("/se" → "/setup").
    onSubmit(menuOpen && highlighted ? `/${highlighted.name}` : text);
  };

  const nameWidth = Math.max(0, ...matches.map((c) => c.name.length)) + 1;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={busy ? theme.dim : theme.accent} paddingX={1}>
        <Text color={theme.accent}>{"> "}</Text>
        <TextInput
          key={inputKey}
          value={value}
          onChange={type}
          onSubmit={handleSubmit}
          placeholder={busy ? "" : "Type a message, or / for commands"}
        />
      </Box>
      {menuOpen && (
        <Box flexDirection="column" paddingX={2}>
          {matches.map((command) => {
            const active = command === highlighted;
            return (
              <Text key={command.name} color={active ? theme.accent : undefined} wrap="truncate-end">
                {active ? "❯ " : "  "}
                {`/${command.name}`.padEnd(nameWidth + 2)}
                <Text color={theme.dim}>{command.description}</Text>
              </Text>
            );
          })}
          <Text color={theme.dim}>{"  "}↑/↓ select · Enter run · Tab complete · Esc hide</Text>
        </Box>
      )}
    </Box>
  );
}
