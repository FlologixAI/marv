// The agent loop: the heart of a coding agent.
//
//   send the conversation (+ tool definitions) → the model replies
//     ├─ it asked for tools?  run them, append the results, go again
//     └─ plain answer?        done
//
// The model decides which tools to use; this loop only runs what it asks for
// and reports back. It knows nothing about the UI or the vendor: it yields
// events, and `history` (the conversation the model sees) is appended to in
// place, never rewritten, so every request starts with the previous one and
// the provider's prompt cache keeps hitting.
import type { ChatTurn, Provider, ToolCall, ToolSpec, Usage } from "./provider/types.ts";
import type { ToolResult } from "./tools/types.ts";

export const DEFAULT_MAX_STEPS = 25;

export type LoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage"; usage: Usage }
  /** One step's reply text is complete. */
  | { type: "assistant"; text: string }
  | { type: "tool_start"; call: ToolCall; label: string }
  | { type: "tool_end"; call: ToolCall; result: ToolResult & { label: string } }
  | { type: "error"; message: string }
  | { type: "done"; reason: "end" | "length" | "aborted" | "max_steps" | "error" };

interface Options {
  provider: Provider;
  /** The conversation; appended to as the run goes. */
  history: ChatTurn[];
  system: string;
  tools: ToolSpec[];
  runTool: (call: ToolCall) => Promise<ToolResult & { label: string }>;
  signal: AbortSignal;
  maxSteps?: number;
}

/** The transcript label for a call before it runs ("src/app.ts"), falling back to the raw arguments. */
function labelOf(call: ToolCall): string {
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    return String(args.path ?? args.pattern ?? call.arguments);
  } catch {
    return call.arguments;
  }
}

export async function* runAgent({
  provider,
  history,
  system,
  tools,
  runTool,
  signal,
  maxSteps = DEFAULT_MAX_STEPS,
}: Options): AsyncGenerator<LoopEvent> {
  for (let step = 0; step < maxSteps; step++) {
    let text = "";
    const calls: ToolCall[] = [];
    let error: string | null = null;
    let stopReason: string | undefined;

    for await (const event of provider.stream(history, { system, tools, signal })) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          yield event;
          break;
        case "thinking_delta":
        case "usage":
          yield event;
          break;
        case "tool_call":
          calls.push(event.call);
          break;
        case "done":
          stopReason = event.reason;
          break;
        case "error":
          error = event.message;
          break;
      }
    }

    if (text || calls.length > 0) {
      history.push(calls.length > 0 ? { role: "assistant", text, toolCalls: calls } : { role: "assistant", text });
    }
    if (text) yield { type: "assistant", text };

    if (error) {
      yield { type: "error", message: error };
      yield { type: "done", reason: "error" };
      return;
    }
    if (calls.length === 0) {
      yield { type: "done", reason: signal.aborted ? "aborted" : stopReason === "length" ? "length" : "end" };
      return;
    }

    // Every call must get a result, even after an interrupt: a request with an
    // unanswered tool call is rejected by the API.
    for (const call of calls) {
      if (signal.aborted) {
        history.push({ role: "tool", callId: call.id, name: call.name, text: "Interrupted by the user before this tool ran." });
        continue;
      }
      yield { type: "tool_start", call, label: labelOf(call) };
      const result = await runTool(call);
      history.push({ role: "tool", callId: call.id, name: call.name, text: result.output });
      yield { type: "tool_end", call, result };
    }
    if (signal.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }
  }

  yield {
    type: "error",
    message: `Stopped after ${maxSteps} steps without a final answer. Ask again to let it continue.`,
  };
  yield { type: "done", reason: "max_steps" };
}
