import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { theme } from "./theme.ts";

export interface SelectItem<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

interface Props<T extends string> {
  items: readonly SelectItem<T>[];
  initialValue?: T;
  onSelect: (value: T) => void;
}

// A vertical list: ↑/↓ to move, Enter to choose.
export function Select<T extends string>({ items, initialValue, onSelect }: Props<T>) {
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((item) => item.value === initialValue)));

  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % items.length);
    else if (key.return) onSelect(items[index]!.value);
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const active = i === index;
        return (
          <Text key={item.value} color={active ? theme.accent : undefined}>
            {active ? "❯ " : "  "}
            {item.label}
            {item.hint && <Text color={theme.dim}> · {item.hint}</Text>}
          </Text>
        );
      })}
    </Box>
  );
}
