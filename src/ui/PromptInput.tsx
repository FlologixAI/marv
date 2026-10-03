import { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { theme } from "./theme.ts";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Previous submissions, oldest first. */
  history: string[];
  busy: boolean;
}

export function PromptInput({ value, onChange, onSubmit, history, busy }: Props) {
  // -1 means "not browsing history" (editing a fresh line).
  const [historyIndex, setHistoryIndex] = useState(-1);

  useInput((_input, key) => {
    if (key.upArrow && history.length > 0) {
      const next = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(next);
      onChange(history[next]!);
    } else if (key.downArrow && historyIndex !== -1) {
      const next = historyIndex + 1;
      if (next >= history.length) {
        setHistoryIndex(-1);
        onChange("");
      } else {
        setHistoryIndex(next);
        onChange(history[next]!);
      }
    }
  });

  const handleSubmit = (text: string) => {
    setHistoryIndex(-1);
    onSubmit(text);
  };

  return (
    <Box borderStyle="round" borderColor={busy ? theme.dim : theme.accent} paddingX={1}>
      <Text color={theme.accent}>{"> "}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={handleSubmit}
        placeholder={busy ? "" : "Type a message, or /help"}
      />
    </Box>
  );
}
