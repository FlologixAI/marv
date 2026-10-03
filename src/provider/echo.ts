import type { AgentEvent, ChatTurn, Provider, StreamOptions } from "./types.ts";

// A fake provider that repeats the last user message back, one word at a time.
// It exercises the exact same streaming path a real LLM will use.
export class EchoProvider implements Provider {
  readonly name = "echo";

  constructor(private readonly delayMs = 40) {}

  async *stream(history: ChatTurn[], { signal }: StreamOptions = {}): AsyncIterable<AgentEvent> {
    const last = history.findLast((turn) => turn.role === "user");
    const words = `You said: ${last?.text ?? ""}`.split(/(\s+)/);

    for (const word of words) {
      if (signal?.aborted) break;
      await Bun.sleep(this.delayMs);
      yield { type: "text_delta", text: word };
    }
    yield { type: "done" };
  }
}
