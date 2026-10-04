// The adapter for "OpenAI-compatible" chat APIs (OpenRouter, and anything
// else that speaks POST /chat/completions with streaming). It translates
// their stream into ekko's AgentEvents, so nothing above this file knows
// which vendor (or which wire format) is on the other end.
import { errorMessage, httpError, unreachable } from "./errors.ts";
import { parseSSE } from "./sse.ts";
import type { AgentEvent, ChatTurn, Provider, StreamOptions, ToolCall } from "./types.ts";

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
  /** Extra request body fields. */
  body?: Record<string, unknown>;
  /** Appended when the server can't be reached at all. */
  offlineHint?: string;
}

/** A tool call as it streams in: id and name first, arguments in pieces. */
interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** The shape of one streamed chunk; we only read the fields we use. */
interface Chunk {
  choices?: {
    delta?: {
      content?: string | null;
      // Reasoning arrives as `reasoning` (OpenRouter) or `reasoning_content` (DeepSeek-style servers).
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

/** ekko's conversation in OpenAI's message format. Deterministic, so repeated requests share a cacheable prefix. */
function toMessages(history: ChatTurn[], system?: string) {
  return [
    ...(system ? [{ role: "system", content: system }] : []),
    ...history.map((turn) => {
      switch (turn.role) {
        case "user":
          return { role: "user", content: turn.text };
        case "assistant":
          return turn.toolCalls
            ? {
                role: "assistant",
                content: turn.text,
                tool_calls: turn.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : { role: "assistant", content: turn.text };
        case "tool":
          return { role: "tool", tool_call_id: turn.callId, content: turn.text };
      }
    }),
  ];
}

export class OpenAICompatProvider implements Provider {
  constructor(private readonly options: Options) {}

  get name() {
    return this.options.name;
  }

  async *stream(history: ChatTurn[], { system, tools, signal }: StreamOptions = {}): AsyncIterable<AgentEvent> {
    const { baseUrl, model, apiKey, label } = this.options;

    // The API is stateless: every request carries the whole conversation.
    const body = {
      model,
      stream: true,
      // Ask for token counts (incl. cached tokens) in the final chunk.
      stream_options: { include_usage: true },
      messages: toMessages(history, system),
      ...(tools?.length
        ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
      ...this.options.body,
    };

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      yield { type: "error", message: unreachable(label, baseUrl, err, this.options.offlineHint) };
      return;
    }

    if (!response.ok) {
      yield { type: "error", message: httpError(response.status, await errorMessage(response), label, model) };
      return;
    }

    // Tool calls arrive in fragments keyed by index; they're only complete at the end.
    const pending = new Map<number, ToolCall>();
    let reason: string | undefined;
    try {
      for await (const data of parseSSE(response.body!)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as Chunk;
        // Errors can also arrive mid-stream, after the 200 status was already sent.
        if (chunk.error) {
          yield { type: "error", message: `${label}: ${chunk.error.message ?? "unknown error"}` };
          return;
        }
        if (chunk.usage) {
          const { prompt_tokens = 0, completion_tokens = 0, prompt_tokens_details } = chunk.usage;
          yield {
            type: "usage",
            usage: { promptTokens: prompt_tokens, completionTokens: completion_tokens, cachedTokens: prompt_tokens_details?.cached_tokens },
          };
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) reason = choice.finish_reason;
        const delta = choice?.delta;
        const thinking = delta?.reasoning ?? delta?.reasoning_content;
        if (thinking) yield { type: "thinking_delta", text: thinking };
        if (delta?.content) yield { type: "text_delta", text: delta.content };
        for (const fragment of delta?.tool_calls ?? []) {
          const index = fragment.index ?? pending.size;
          const call = pending.get(index) ?? { id: "", name: "", arguments: "" };
          if (fragment.id) call.id = fragment.id;
          if (fragment.function?.name) call.name = fragment.function.name;
          call.arguments += fragment.function?.arguments ?? "";
          pending.set(index, call);
        }
      }
    } catch (err) {
      if (signal?.aborted) return; // ctrl+c: the app says "Interrupted."
      yield { type: "error", message: `${label}: the stream broke off (${(err as Error).message})` };
      return;
    }

    for (const [index, call] of [...pending].sort(([a], [b]) => a - b)) {
      yield { type: "tool_call", call: { ...call, id: call.id || `call_${index}` } };
    }
    yield { type: "done", reason };
  }
}
