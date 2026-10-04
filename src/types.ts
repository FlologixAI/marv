// A single entry in the transcript the user sees.
// "system" is for Marv's own notices (help text, errors) — not the LLM system prompt.
// "tool" is a tool call the agent made, shown with its outcome.
export type Role = "user" | "assistant" | "system" | "tool";

export interface ToolStatus {
  /** What it was called on, e.g. the file path. */
  label: string;
  status: "running" | "done" | "error" | "declined";
  /** e.g. "42 lines", or the error. */
  summary?: string;
}

export interface Message {
  id: number;
  role: Role;
  /** For "tool": the tool name. */
  text: string;
  /** Renders a system message in the error color. */
  isError?: boolean;
  tool?: ToolStatus;
}
