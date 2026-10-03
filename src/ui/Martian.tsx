import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.ts";

// ekko's mascot: a little martian with two antennae and big eyes.
// Every frame is the same 7×7 block, so swapping frames never moves the layout.
export const FRAMES = {
  idle: [
    " ●   ● ",
    "  ╲ ╱  ",
    "╭─────╮",
    "│ ◉ ◉ │",
    "│  ◡  │",
    "╰┬───┬╯",
    " ╹   ╹ ",
  ],
  blink: [
    " ●   ● ",
    "  ╲ ╱  ",
    "╭─────╮",
    "│ ─ ─ │",
    "│  ◡  │",
    "╰┬───┬╯",
    " ╹   ╹ ",
  ],
  lookLeft: [
    " ●   ● ",
    "  ╲ ╱  ",
    "╭─────╮",
    "│◉ ◉  │",
    "│ ◡   │",
    "╰┬───┬╯",
    " ╹   ╹ ",
  ],
  lookRight: [
    " ●   ● ",
    "  ╲ ╱  ",
    "╭─────╮",
    "│  ◉ ◉│",
    "│   ◡ │",
    "╰┬───┬╯",
    " ╹   ╹ ",
  ],
  // Both antennae tilt the same way; alternating the two is the wiggle.
  tiltLeft: [
    " ● ●   ",
    "  ╲ ╲  ",
    "╭─────╮",
    "│ ◉ ◉ │",
    "│  ◡  │",
    "╰┬───┬╯",
    " ╹   ╹ ",
  ],
  tiltRight: [
    "   ● ● ",
    "  ╱ ╱  ",
    "╭─────╮",
    "│ ◉ ◉ │",
    "│  ◡  │",
    "╰┬───┬╯",
    " ╹   ╹ ",
  ],
} as const;

type FrameName = keyof typeof FRAMES;
interface Step {
  frame: FrameName;
  ms: number;
}

const wiggle = (times: number): Step[] =>
  Array.from({ length: times }, () => [
    { frame: "tiltLeft", ms: 160 },
    { frame: "tiltRight", ms: 160 },
  ]).flat() as Step[];

/** Played once when the martian appears: an antenna-wiggle hello. */
export const GREETING: Step[] = [...wiggle(3), { frame: "idle", ms: 2500 }];

/** Then this loops forever: mostly still, with a blink, a look around, and a wiggle. */
export const IDLE_LOOP: Step[] = [
  { frame: "blink", ms: 150 },
  { frame: "idle", ms: 3500 },
  { frame: "lookLeft", ms: 700 },
  { frame: "lookRight", ms: 700 },
  { frame: "idle", ms: 3000 },
  { frame: "blink", ms: 150 },
  { frame: "idle", ms: 200 },
  { frame: "blink", ms: 150 },
  { frame: "idle", ms: 3500 },
  ...wiggle(2),
  { frame: "idle", ms: 4000 },
];

// Antenna tips and eyes glow gold; everything else is the body color.
const GLOW = new Set(["●", "◉"]);

function Row({ text }: { text: string }) {
  // Group runs of same-colored characters into one <Text> each.
  const runs: { glow: boolean; text: string }[] = [];
  for (const char of text) {
    const glow = GLOW.has(char);
    const last = runs.at(-1);
    if (last && last.glow === glow) last.text += char;
    else runs.push({ glow, text: char });
  }
  return (
    <Text>
      {runs.map((run, i) => (
        <Text key={i} color={run.glow ? theme.mascotGlow : theme.accent}>
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

export function Martian({ animate = true }: { animate?: boolean }) {
  // Position in GREETING followed by IDLE_LOOP; past the greeting, it wraps around the loop.
  const [step, setStep] = useState(0);
  const current = step < GREETING.length ? GREETING[step]! : IDLE_LOOP[(step - GREETING.length) % IDLE_LOOP.length]!;

  useEffect(() => {
    if (!animate) return;
    const timer = setTimeout(() => setStep((n) => n + 1), current.ms);
    return () => clearTimeout(timer);
  }, [animate, step, current.ms]);

  const frame = animate ? FRAMES[current.frame] : FRAMES.idle;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {frame.map((row, i) => (
        <Row key={i} text={row} />
      ))}
    </Box>
  );
}
