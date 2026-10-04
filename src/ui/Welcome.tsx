import { Box, Text } from "ink";
import { Martian } from "./Martian.tsx";
import { theme } from "./theme.ts";

// The banner at the top of the session: the Marv martian, with the
// welcome text centered beside it.
export function Welcome({
  version,
  cwd,
  instructions,
  skills = 0,
  memories = 0,
  animate = true,
}: {
  version: string;
  cwd: string;
  /** An AGENTS.md was loaded. */
  instructions?: boolean;
  /** How many skills were found. */
  skills?: number;
  /** How many memories were loaded. */
  memories?: number;
  animate?: boolean;
}) {
  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={2} marginBottom={1} gap={3}>
      <Martian animate={animate} />
      <Box flexDirection="column" justifyContent="center">
        <Text>
          <Text bold>Welcome to Marv</Text>
          <Text color={theme.dim}> v{version}</Text>
        </Text>
        <Text color={theme.dim}>/help for commands</Text>
        <Text color={theme.dim}>cwd: {cwd}</Text>
        {(instructions || skills > 0 || memories > 0) && (
          <Text color={theme.dim}>
            {[
              instructions && "AGENTS.md loaded",
              skills > 0 && `${skills} skill${skills === 1 ? "" : "s"} (/skills)`,
              memories > 0 && `${memories} memor${memories === 1 ? "y" : "ies"} (/memory)`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        )}
      </Box>
    </Box>
  );
}
