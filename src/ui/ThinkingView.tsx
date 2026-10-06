import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import Spinner from "ink-spinner";
import { printable } from "../printable.ts";
import { draftLabel, draftPreview } from "../tool-draft.ts";
import { estimateTokens, tokens } from "../usage.ts";
import { theme } from "./theme.ts";

const PREVIEW_LINES = 3;
const TAIL_CHARS = 4000;

/** How long it's been: "12s", then "1m 05s". */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// Shown while waiting for the reply. For thinking models it previews the tail
// of their reasoning, so a long think visibly makes progress instead of
// looking like a hang. The time counts from when it appeared: one wait for one
// reply, like the "Thought for 8s" line that follows it.
// `count`: the text whose tokens are counted, when that isn't `thought` (a tool call's raw JSON). `code`: the
// preview is code, so its lines keep their indentation.
export function ThinkingView({ thought, label = "Thinking…", count = thought, code = false }: { thought: string; label?: string; count?: string; code?: boolean }) {
  const [since] = useState(Date.now);
  const [now, setNow] = useState(since);
  useEffect(() => {
    // Once a second is all a seconds counter needs (the spinner animates itself).
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // Only the end is shown, so only the end is cleaned up: a draft can be a 100k-character file.
  const tail = printable(thought.slice(-TAIL_CHARS))
    .split("\n")
    .map((line) => (code ? line.replace(/\t/g, "  ").trimEnd() : line.trim()))
    .filter((line) => line.trim() !== "")
    .slice(-PREVIEW_LINES);
  // An estimate: the real count arrives with the reply's usage, when this view is already gone.
  const estimate = estimateTokens(count.trim());
  const shown = [now - since >= 1000 && elapsed(now - since), estimate > 0 && `~${tokens(estimate)} tokens`].filter(Boolean);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={theme.accent}>
          <Spinner type="dots" />
        </Text>
        <Text color={theme.dim}>
          {" "}
          {label}
          {shown.length > 0 && ` (${shown.join(" · ")})`}
        </Text>
      </Text>
      {tail.map((line, i) => (
        <Text key={i} color={theme.dim} italic wrap="truncate-end">
          {"  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * A tool call the model is still writing: "Writing src/app.js…", the time and tokens so far, and the last lines
 * of the code. A long write_file streams for minutes, and without this the screen sat at "Thinking…".
 */
export function DraftView({ name, args }: { name: string; args: string }) {
  const label = useMemo(() => draftLabel(name, args), [name, args]);
  const preview = useMemo(() => draftPreview(name, args), [name, args]);
  return <ThinkingView label={label} thought={preview} count={args} code />;
}
