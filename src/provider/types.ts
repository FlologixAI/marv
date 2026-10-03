// The seam between ekko and any LLM vendor.
//
// Every provider (echo today, Anthropic in milestone 3, maybe OpenAI later)
// turns its own streaming format into these events. The UI and the agent
// loop only ever see AgentEvent, so swapping vendors never touches them.

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface Provider {
  /** Shown in the status bar, e.g. "echo" or "claude-opus-5-5". */
  readonly name: string;
  stream(history: ChatTurn[], signal?: AbortSignal): AsyncIterable<AgentEvent>;
}
