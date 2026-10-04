import type { RenderOptions } from "ink";
import { selection } from "./selection.ts";

// How Marv asks Ink to draw. Kept separate from cli.tsx so tests can render
// with exactly these options.
export const renderOptions = {
  // ctrl+c is handled inside the app (interrupt / clear / confirm exit).
  exitOnCtrlC: false,
  // Draw on the terminal's separate full-screen buffer (like vim or htop).
  // Your shell's screen is restored untouched when Marv exits.
  alternateScreen: true,
  // Rewrite only the lines that changed. Without this Ink erases and redraws
  // the whole screen on every update (each martian frame, each keystroke),
  // which flickers in terminals that ignore synchronized output.
  incrementalRendering: true,
  // Our Ink patch: lets the selection highlight be drawn into each frame.
  transformOutput: selection.transformOutput,
} satisfies RenderOptions;
