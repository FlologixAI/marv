import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.ts";

// Ekko's mascot: a sturdy little martian, drawn in heavy box lines, with
// antennae, arms and feet. One color (the theme accent).
// Every frame is the same 12×7 block (the raised arm uses the last column),
// so swapping frames never moves the layout.
const BODY = [" ┃   ◡   ┃  ", " ┗┳━━━━━┳┛  ", "  ┻     ┻   "];
const ANTENNAE = [" ●       ●  ", "  ╲     ╱   "];
const HEAD = " ┏━━━━━━━┓  ";

export const FRAMES = {
  idle: [...ANTENNAE, HEAD, "━┫ ◉   ◉ ┣━ ", ...BODY],
  blink: [...ANTENNAE, HEAD, "━┫ ─   ─ ┣━ ", ...BODY],
  lookLeft: [...ANTENNAE, HEAD, "━┫◉   ◉  ┣━ ", " ┃  ◡    ┃  ", ...BODY.slice(1)],
  lookRight: [...ANTENNAE, HEAD, "━┫  ◉   ◉┣━ ", " ┃    ◡  ┃  ", ...BODY.slice(1)],
  // Both antennae lean the same way; alternating the two is the wiggle.
  tiltLeft: [" ●     ●    ", "  ╲     ╲   ", HEAD, "━┫ ◉   ◉ ┣━ ", ...BODY],
  tiltRight: ["   ●     ●  ", "  ╱     ╱   ", HEAD, "━┫ ◉   ◉ ┣━ ", ...BODY],
  // The right arm raised; alternating the hand between ╱ and │ is the wave.
  waveOut: [...ANTENNAE, " ┏━━━━━━━┓ ╱", "━┫ ◉   ◉ ┣╯ ", ...BODY],
  waveUp: [...ANTENNAE, " ┏━━━━━━━┓│ ", "━┫ ◉   ◉ ┣╯ ", ...BODY],
} as const;

type FrameName = keyof typeof FRAMES;
interface Step {
  frame: FrameName;
  ms: number;
}

const repeat = (times: number, steps: Step[]): Step[] => Array.from({ length: times }, () => steps).flat();
const wiggle = (times: number) =>
  repeat(times, [
    { frame: "tiltLeft", ms: 160 },
    { frame: "tiltRight", ms: 160 },
  ]);
const wave = (times: number) =>
  repeat(times, [
    { frame: "waveOut", ms: 220 },
    { frame: "waveUp", ms: 220 },
  ]);

/** Played once when the martian appears: a wave hello. */
export const GREETING: Step[] = [...wave(3), { frame: "idle", ms: 2500 }];

/** Then this loops forever: mostly still, with a blink, a look around, a wiggle, and the odd wave. */
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
  ...wave(2),
  { frame: "idle", ms: 4000 },
];

export function Martian({ animate = true }: { animate?: boolean }) {
  // Position in GREETING followed by IDLE_LOOP; past the greeting, it wraps around the loop.
  const [step, setStep] = useState(0);
  const current = step < GREETING.length ? GREETING[step]! : IDLE_LOOP[(step - GREETING.length) % IDLE_LOOP.length]!;

  useEffect(() => {
    if (!animate) return;
    const timer = setTimeout(() => setStep((n) => n + 1), current.ms);
    return () => clearTimeout(timer);
  }, [animate, step, current.ms]);

  return <MartianFrame name={animate ? current.frame : "idle"} />;
}

/** One pose, drawn in the accent color. */
export function MartianFrame({ name }: { name: FrameName }) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {FRAMES[name].map((row, i) => (
        <Text key={i} color={theme.accent}>
          {row}
        </Text>
      ))}
    </Box>
  );
}
