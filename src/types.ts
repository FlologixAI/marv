// A single entry in the transcript the user sees.
// "system" is for ekko's own notices (help text, errors) — not the LLM system prompt.
export type Role = "user" | "assistant" | "system";

export interface Message {
  id: number;
  role: Role;
  text: string;
  /** Renders a system message in the error color. */
  isError?: boolean;
}
