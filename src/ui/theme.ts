// All colors live here so the look can be changed in one place.
export const theme = {
  accent: "#2dd4bf",
  // Exact shades, not the terminal's "gray" (ANSI bright black): terminals
  // pick that shade themselves, and GNOME Console's is ~2.5:1 against its
  // background, hard to read. Contrast on a dark background (#1e1e1e):
  user: "#d4d4d8", // your messages: ~11:1, visible but distinct from replies
  assistant: "white",
  dim: "#a1a1aa", // reasoning, hints, status: ~6.5:1, quieter but readable
  error: "#f87171",
  warning: "#fbbf24",
  code: "#7dd3fc", // inline code and links in replies
  codeBlock: "#cbd5e1", // fenced code blocks
  diffAdd: "#4ade80", // added lines in a change
  diffDel: "#f87171", // removed lines
  // Top-to-bottom gradient for the splash logo (one color per line):
  // teal fading into a gold accent.
  gradient: ["#5eead4", "#2dd4bf", "#14b8a6", "#22d3ee", "#38bdf8", "#facc15"],
} as const;
