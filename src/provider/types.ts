// The seam between ekko and any LLM vendor.
//
// Every provider (Echo, and OpenRouter/Ollama through the OpenAI-compatible
// adapter) turns its own streaming format into these events. The UI and the agent
// loop only ever see AgentEvent, so swapping vendors never touches them.

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  /** The model's private reasoning before it answers (thinking models only). */
  | { type: "thinking_delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface StreamOptions {
  /** Instructions sent ahead of the conversation ("You are ekko…"). */
  system?: string;
  /** Aborted by ctrl+c to stop the reply (and the HTTP request behind it). */
  signal?: AbortSignal;
}

export interface Provider {
  /** Shown in the status bar, e.g. "echo" or "openrouter · z-ai/glm-5.3". */
  readonly name: string;
  stream(history: ChatTurn[], options?: StreamOptions): AsyncIterable<AgentEvent>;
}
