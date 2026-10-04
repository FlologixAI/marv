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

/** A model that follows a script: each request gets the next list of events. Records every request. */
export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  requests: { history: ChatTurn[]; options: StreamOptions }[] = [];
  constructor(
    private steps: AgentEvent[][],
    readonly contextLength?: number,
  ) {}

  async *stream(history: ChatTurn[], options: StreamOptions = {}) {
    this.requests.push({ history: structuredClone(history), options });
    const step = this.steps.shift() ?? [{ type: "text_delta", text: "(script ended)" }, { type: "done" }];
    for (const event of step) {
      await Bun.sleep(0);
      yield event as AgentEvent;
    }
  }
}
