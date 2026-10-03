import type { AgentEvent, ChatTurn, Provider, StreamOptions } from "../src/provider/types.ts";

// A stand-in model for UI tests: replies "You said: <last message>" one word at
// a time, instantly and offline, through the same streaming path a real one uses.
export class FakeProvider implements Provider {
  readonly name = "fake · test-model";

  async *stream(history: ChatTurn[], { signal }: StreamOptions = {}): AsyncIterable<AgentEvent> {
    const last = history.findLast((turn) => turn.role === "user");
    for (const word of `You said: ${last?.text ?? ""}`.split(/(\s+)/)) {
      if (signal?.aborted) break;
      await Bun.sleep(0);
      yield { type: "text_delta", text: word };
    }
    yield { type: "done" };
  }
}
