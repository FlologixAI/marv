// The adapter for Ollama's native chat API (POST /api/chat). We use it
// instead of Ollama's OpenAI-compatible endpoint because only the native one
// lets us set the context window (num_ctx): Ollama's default of 4096 tokens
// is too small for an agent that reads files.
import { errorMessage, httpError, unreachable } from "./errors.ts";
import type { AgentEvent, ChatTurn, Provider, StreamOptions, ToolCall } from "./types.ts";

const LABEL = "Ollama";

interface Options {
  /** Where Ollama listens, e.g. http://localhost:11434 (a trailing /v1 is ignored). */
  baseUrl: string;
  model: string;
  /** Context window to load the model with (num_ctx). */
  contextLength: number;
  /** Let thinking models reason first. Off makes them answer directly. */
  thinking: boolean;
}

/** One line of Ollama's stream. */
interface Line {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Ollama streams newline-delimited JSON: one complete object per line. */
async function* parseNDJSON(body: ReadableStream<Uint8Array>): AsyncGenerator<Line> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as Line;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as Line;
}

/** Marv's conversation in Ollama's message format (tool arguments as objects, results tagged by tool name). */
function toMessages(history: ChatTurn[], system?: string) {
  const parse = (args: string) => {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
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
                tool_calls: turn.toolCalls.map((c) => ({ function: { name: c.name, arguments: parse(c.arguments) } })),
              }
            : { role: "assistant", content: turn.text };
        case "tool":
          return { role: "tool", tool_name: turn.name, content: turn.text };
      }
    }),
  ];
}

export class OllamaProvider implements Provider {
  constructor(private readonly options: Options) {}

  get name() {
    return `ollama · ${this.options.model}`;
  }

  get contextLength() {
    return this.options.contextLength;
  }

  async *stream(history: ChatTurn[], { system, tools, signal }: StreamOptions = {}): AsyncIterable<AgentEvent> {
    const { model, contextLength, thinking } = this.options;
    const baseUrl = this.options.baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: true,
          think: thinking,
          // Must stay the same for the whole session: a different num_ctx reloads the model.
          options: { num_ctx: contextLength },
          messages: toMessages(history, system),
          ...(tools?.length
            ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
            : {}),
        }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      yield { type: "error", message: unreachable(LABEL, baseUrl, err, "Is Ollama running? Start it with `ollama serve`.") };
      return;
    }

    if (!response.ok) {
      yield { type: "error", message: httpError(response.status, await errorMessage(response), LABEL, model) };
      return;
    }

    const calls: ToolCall[] = [];
    let reason: string | undefined;
    try {
      for await (const line of parseNDJSON(response.body!)) {
        if (line.error) {
          yield { type: "error", message: `${LABEL}: ${line.error}` };
          return;
        }
        const { thinking: thought, content, tool_calls } = line.message ?? {};
        if (thought) yield { type: "thinking_delta", text: thought };
        if (content) yield { type: "text_delta", text: content };
        for (const call of tool_calls ?? []) {
          calls.push({
            id: call.id ?? `call_${calls.length}`,
            name: call.function.name,
            // Ollama gives an object; store it as JSON text like every other provider.
            arguments: JSON.stringify(call.function.arguments ?? {}),
          });
        }
        if (line.done) {
          reason = line.done_reason;
          yield { type: "usage", usage: { promptTokens: line.prompt_eval_count ?? 0, completionTokens: line.eval_count ?? 0 } };
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      yield { type: "error", message: `${LABEL}: the stream broke off (${(err as Error).message})` };
      return;
    }

    for (const call of calls) yield { type: "tool_call", call };
    yield { type: "done", reason };
  }
}
