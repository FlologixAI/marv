import { Box, Text, useInput } from "ink";
import type { ApprovalRequest, Decision, DiffLine } from "../tools/types.ts";
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
export function Approval({ request, onDecide }: { request: ApprovalRequest; onDecide: (decision: Decision) => void }) {
  const { preview, scope } = request;

  useInput((_input, key) => {
    if (key.escape) onDecide("no");
  });

  const diff = preview.diff ?? [];
  const shown = diff.slice(0, MAX_DIFF_LINES);
  const hidden = diff.length - shown.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={preview.warning ? theme.warning : theme.accent} paddingX={1}>
      <Text bold>{preview.title}</Text>

      {(shown.length > 0 || preview.text) && (
        <Box flexDirection="column" marginTop={1}>
          {preview.text && (
            <Text color={theme.code}>
              <Text color={theme.dim}>$ </Text>
              {preview.text}
            </Text>
          )}
          {shown.map((line, i) => (
            <Text key={i} color={COLOR[line.kind]} wrap="truncate-end">
              {line.kind === "gap" ? "  …" : MARK[line.kind] + line.text}
            </Text>
          ))}
          {hidden > 0 && <Text color={theme.dim}>  … {hidden} more lines</Text>}
        </Box>
      )}

      {preview.note && <Text color={theme.dim}>{preview.note}</Text>}
      {preview.warning && <Text color={theme.warning}>⚠ {preview.warning}</Text>}

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
