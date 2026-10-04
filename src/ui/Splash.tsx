import { useEffect } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { theme } from "./theme.ts";

const LOGO = [
  "███╗   ███╗ █████╗ ██████╗ ██╗   ██╗",
  "████╗ ████║██╔══██╗██╔══██╗██║   ██║",
  "██╔████╔██║███████║██████╔╝██║   ██║",
  "██║╚██╔╝██║██╔══██║██╔══██╗╚██╗ ██╔╝",
  "██║ ╚═╝ ██║██║  ██║██║  ██║ ╚████╔╝ ",
  "╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ",
];
const LOGO_WIDTH = LOGO[0]!.length;

interface Props {
  version: string;
  cwd: string;
  /** How long to show the splash before continuing on its own. */
  durationMs: number;
  onDone: () => void;
}

export function Splash({ version, cwd, durationMs, onDone }: Props) {
  const { columns } = useWindowSize();

  useEffect(() => {
    const timer = setTimeout(onDone, durationMs);
    return () => clearTimeout(timer);
  }, [durationMs, onDone]);

  // Any key skips the splash.
  useInput(() => onDone());

  const fitsLogo = columns >= LOGO_WIDTH + 4;

  return (
    <Box flexDirection="column" alignItems="center" width={columns} paddingY={1}>
      {fitsLogo ? (
        LOGO.map((line, i) => (
          <Text key={i} color={theme.gradient[i % theme.gradient.length]}>
            {line}
          </Text>
        ))
      ) : (
        <Text bold color={theme.accent}>
          Marv
        </Text>
      )}
      <Box marginTop={1}>
        <Text color={theme.dim}>a terminal coding agent · v{version}</Text>
      </Box>
      <Text color={theme.dim}>{cwd}</Text>
      <Box marginTop={1}>
        <Text color={theme.accent} italic>
          "Take me to your codebase."
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim} italic>
          press any key to continue
        </Text>
      </Box>
    </Box>
  );
}
