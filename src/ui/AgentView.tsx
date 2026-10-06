import { memo } from "react";
import { Box, Text } from "ink";
import type { AgentLog } from "../agent-log.ts";
import { printable } from "../printable.ts";
import { MessageView } from "./MessageView.tsx";
import { theme } from "./theme.ts";
import { DraftView, ThinkingView } from "./ThinkingView.tsx";

/** Pinned above a subagent's view: whose it is, and the way back. */
export function AgentViewHeader({ log }: { log: AgentLog }) {
  return (
    <Box paddingX={1} marginBottom={1} flexShrink={0} justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text color={theme.accent}>● agent </Text>
        <Text bold>{printable(log.title)}</Text>
        <Text color={theme.dim}> · {log.running ? "running" : "finished"}</Text>
      </Text>
      <Box flexShrink={0} marginLeft={2}>
        <Text color={theme.dim}>esc to go back</Text>
      </Box>
    </Box>
  );
}

/**
 * A subagent's own transcript: its task, what it said and thought, and its
 * tool calls, live while it runs. The log is updated in place; `version`
 * changes when it did (memo would otherwise skip the render).
 */
export const AgentView = memo(function AgentView({
  log,
  showSteps = false,
}: {
  log: AgentLog;
  version: number;
  /** ctrl+o: whole diffs. */
  showSteps?: boolean;
}) {
  const waiting = log.running && log.streaming === "" && log.messages.at(-1)?.tool?.status !== "running";
  return (
    <>
      {log.messages.map((message) => (
        // Only entries with a diff get the flag, so ctrl+o re-renders just those.
        <MessageView key={message.id} message={message} showSteps={message.tool?.diff ? showSteps : false} />
      ))}
      {log.streaming !== "" ? <MessageView message={{ role: "assistant", text: log.streaming }} streaming /> : waiting && !log.draft && <ThinkingView thought={log.thinking} />}
      {log.running && log.draft && log.messages.at(-1)?.tool?.status !== "running" && <DraftView name={log.draft.name} args={log.draft.args} />}
    </>
  );
});
