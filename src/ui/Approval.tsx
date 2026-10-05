import { Box, Text, useInput } from "ink";
import type { ApprovalRequest, Decision, DiffLine } from "../tools/types.ts";
import { printable } from "../printable.ts";
import { Select } from "./Select.tsx";
import { theme } from "./theme.ts";

const MAX_DIFF_LINES = 24;

const MARK: Record<DiffLine["kind"], string> = { add: "+ ", del: "- ", ctx: "  ", gap: "  " };
const COLOR: Record<DiffLine["kind"], string> = { add: theme.diffAdd, del: theme.diffDel, ctx: theme.dim, gap: theme.dim };

/**
 * Asks before a tool changes something: what it will do (a diff, or the
 * command), then yes / yes for the rest of the session / no. Shown in place
 * of the prompt while the agent waits for the answer.
 */
export function Approval({
  request,
  onDecide,
  onCancel,
  waiting = 0,
  escapeCancels = true,
}: {
  request: ApprovalRequest;
  onDecide: (decision: Decision) => void;
  /** Esc: no to this and to everything waiting behind it. */
  onCancel?: () => void;
  /** Other requests queued behind this one (parallel subagents). */
  waiting?: number;
  /** Off while a subagent's view is open: Esc then only closes the view, it doesn't stop the run. */
  escapeCancels?: boolean;
}) {
  const { preview, scope } = request;

  useInput((_input, key) => {
    if (key.escape && escapeCancels) (onCancel ?? (() => onDecide("no")))();
  });

  const diff = preview.diff ?? [];
  const shown = diff.slice(0, MAX_DIFF_LINES);
  const hidden = diff.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={preview.warning ? theme.warning : theme.accent} paddingX={1}>
      {request.agent && <Text color={theme.dim}>[{printable(request.agent)}]</Text>}
      <Text bold>{printable(preview.title)}</Text>

      {(shown.length > 0 || preview.command || preview.text) && (
        <Box flexDirection="column" marginTop={1}>
          {preview.command && (
            <Text color={theme.code}>
              <Text color={theme.dim}>$ </Text>
              {printable(preview.command)}
            </Text>
          )}
          {preview.text && <Text>{printable(preview.text)}</Text>}
          {shown.map((line, i) => (
            <Text key={i} color={COLOR[line.kind]} wrap="truncate-end">
              {line.kind === "gap" ? "  …" : MARK[line.kind] + printable(line.text)}
            </Text>
          ))}
          {hidden > 0 && <Text color={theme.dim}>  … {hidden} more lines</Text>}
        </Box>
      )}

      {preview.note && <Text color={theme.dim}>{printable(preview.note)}</Text>}
      {preview.warning && <Text color={theme.warning}>⚠ {printable(preview.warning)}</Text>}
      {waiting > 0 && <Text color={theme.dim}>{waiting} more waiting</Text>}

      <Box marginTop={1} flexDirection="column">
        <Text>Do you want to proceed?</Text>
        <Select
          items={[
            { value: "yes", label: "Yes" },
            { value: "always", label: `Yes, and don't ask again for ${scope.description} this session` },
            { value: "no", label: "No, and tell Marv what to do instead", hint: "esc" },
          ]}
          onSelect={onDecide}
        />
      </Box>
    </Box>
  );
}
