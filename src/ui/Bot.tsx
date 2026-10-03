import { Box, Text } from "ink";
import { theme } from "./theme.ts";

// The ekko bot: a solid teal head with an antenna and gold eyes.
// The eyes get the head's color as their background, so the face reads as
// one filled block with two lights in it instead of having holes.
export function Bot() {
  const head = (s: string) => <Text color={theme.accent}>{s}</Text>;
  const eye = (
    <Text color={theme.botEyes} backgroundColor={theme.accent}>
      ●
    </Text>
  );

  return (
    <Box flexDirection="column" flexShrink={0}>
      {head("  ▖  ")}
      {head("▟███▙")}
      <Text>
        {head("█")}
        {eye}
        {head("█")}
        {eye}
        {head("█")}
      </Text>
      {head("▜███▛")}
    </Box>
  );
}
