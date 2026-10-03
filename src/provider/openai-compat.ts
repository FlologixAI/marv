// One adapter for every "OpenAI-compatible" chat API: OpenRouter, Ollama,
// and anything else that speaks POST /chat/completions with streaming.
// It translates their stream into ekko's AgentEvents, so nothing above this
// file knows which vendor (or which wire format) is on the other end.
import { parseSSE } from "./sse.ts";
import type { AgentEvent, ChatTurn, Provider, StreamOptions } from "./types.ts";

interface Options {
  /** Shown in the status bar. */
  name: string;
  /** Used in error messages, e.g. "OpenRouter". */
  label: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Extra request headers (e.g. OpenRouter's app attribution). */
  headers?: Record<string, string>;
  /** Extra request body fields (e.g. Ollama's reasoning_effort). */
  body?: Record<string, unknown>;
  /** Appended when the server can't be reached at all. */
  offlineHint?: string;
}

/** The shape of one streamed chunk; we only read the fields we use. */
interface Chunk {
  // Reasoning arrives as `reasoning` (OpenRouter, Ollama) or `reasoning_content` (DeepSeek-style servers).
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null } }[];
  error?: { message?: string };
}

export class OpenAICompatProvider implements Provider {
  constructor(private readonly options: Options) {}

  get name() {
    return this.options.name;
  }

  async *stream(history: ChatTurn[], { system, signal }: StreamOptions = {}): AsyncIterable<AgentEvent> {
    const { baseUrl, model, apiKey, label } = this.options;

    // The API is stateless: every request carries the whole conversation.
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...history.map((turn) => ({ role: turn.role, content: turn.text })),
    ];

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...this.options.headers,
        },
        body: JSON.stringify({ model, stream: true, messages, ...this.options.body }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      const hint = this.options.offlineHint ? ` ${this.options.offlineHint}` : "";
      yield { type: "error", message: `Can't reach ${label} at ${new URL(baseUrl).origin}.${hint} (${(err as Error).message})` };
      return;
    }

    if (!response.ok) {
      yield { type: "error", message: httpError(response.status, await errorMessage(response), label, model) };
      return;
    }

    try {
      for await (const data of parseSSE(response.body!)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as Chunk;
        // Errors can also arrive mid-stream, after the 200 status was already sent.
        if (chunk.error) {
          yield { type: "error", message: `${label}: ${chunk.error.message ?? "unknown error"}` };
          return;
        }
        const delta = chunk.choices?.[0]?.delta;
        const thinking = delta?.reasoning ?? delta?.reasoning_content;
        if (thinking) yield { type: "thinking_delta", text: thinking };
        if (delta?.content) yield { type: "text_delta", text: delta.content };
      }
    } catch (err) {
      if (signal?.aborted) return; // ctrl+c: the app says "Interrupted."
      yield { type: "error", message: `${label}: the stream broke off (${(err as Error).message})` };
      return;
    }
    yield { type: "done" };
  }
}

/** Pulls the message out of an error body ({"error":{"message":…}} or Ollama's {"error":"…"}). */
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    return (typeof body.error === "string" ? body.error : body.error?.message) ?? text;
  } catch {
    return text || response.statusText;
  }
}

/** Turns a status code into something the user can act on. */
function httpError(status: number, detail: string, label: string, model: string): string {
  const reason = (() => {
    switch (status) {
      case 401:
      case 403:
        return `${label} rejected the API key. Run /setup to enter a new one.`;
      case 402:
        return `Your ${label} account is out of credits.`;
      case 404:
        return `Model "${model}" wasn't found on ${label}. Pick another with /model.`;
      case 429:
        return `Rate limited by ${label}. Wait a moment and try again.`;
      default:
        return status >= 500 ? `${label} is having trouble (${status}). Try again shortly.` : `${label} returned ${status}.`;
    }
  })();
  return detail ? `${reason}\n${detail}` : reason;
}
