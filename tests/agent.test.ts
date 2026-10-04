import { describe, expect, test } from "bun:test";
import { runAgent, type LoopEvent } from "../src/agent.ts";
import type { AgentEvent, ChatTurn, Provider, ToolCall, ToolSpec } from "../src/provider/types.ts";
import type { ToolResult } from "../src/tools/types.ts";
import { ScriptedProvider } from "./fake-provider.ts";

const SPECS: ToolSpec[] = [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }];
const call = (id: string, path: string): ToolCall => ({ id, name: "read_file", arguments: JSON.stringify({ path }) });
const say = (text: string): AgentEvent[] => [{ type: "text_delta", text }, { type: "done", reason: "stop" }];
const useTools = (...calls: ToolCall[]): AgentEvent[] => [
  ...calls.map((c) => ({ type: "tool_call" as const, call: c })),
  { type: "done", reason: "tool_calls" },
];

const fakeTool = async (c: ToolCall): Promise<ToolResult & { label: string }> => ({
  output: `contents of ${JSON.parse(c.arguments).path}`,
  summary: "1 line",
  label: JSON.parse(c.arguments).path,
});

async function run(provider: Provider, history: ChatTurn[], opts: Partial<Parameters<typeof runAgent>[0]> = {}) {
  const events: LoopEvent[] = [];
  for await (const event of runAgent({
    provider,
    history,
    system: "SYSTEM",
    tools: SPECS,
    runTool: fakeTool,
    signal: new AbortController().signal,
    ...opts,
  }))
    events.push(event);
  return events;
}

describe("runAgent", () => {
  test("a plain answer is one step", async () => {
    const provider = new ScriptedProvider([say("Hi!")]);
    const history: ChatTurn[] = [{ role: "user", text: "hello" }];
    const events = await run(provider, history);

    expect(history).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "Hi!" },
    ]);
    expect(events.map((e) => e.type)).toEqual(["text_delta", "assistant", "done"]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "end" });
  });

  test("runs the tools the model asks for, then sends the results back", async () => {
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts"), call("c2", "b.ts")), say("Both read.")]);
    const history: ChatTurn[] = [{ role: "user", text: "read a and b" }];
    const events = await run(provider, history);

    expect(history).toEqual([
      { role: "user", text: "read a and b" },
      { role: "assistant", text: "", toolCalls: [call("c1", "a.ts"), call("c2", "b.ts")] },
      { role: "tool", callId: "c1", name: "read_file", text: "contents of a.ts" },
      { role: "tool", callId: "c2", name: "read_file", text: "contents of b.ts" },
      { role: "assistant", text: "Both read." },
    ]);
    // The second request carried the tool results.
    expect(provider.requests[1]!.history.at(-1)).toEqual({ role: "tool", callId: "c2", name: "read_file", text: "contents of b.ts" });
    expect(events.filter((e) => e.type === "tool_start").map((e) => e.type === "tool_start" && e.label)).toEqual(["a.ts", "b.ts"]);
    expect(events.filter((e) => e.type === "tool_end")).toHaveLength(2);
  });

  test("every request extends the previous one exactly (so the prompt cache keeps hitting)", async () => {
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts")), useTools(call("c2", "b.ts")), say("Done."), useTools(call("c3", "c.ts")), say("Again.")]);
    const history: ChatTurn[] = [{ role: "user", text: "first" }];
    await run(provider, history);
    history.push({ role: "user", text: "second" });
    await run(provider, history);

    expect(provider.requests).toHaveLength(5);
    for (let i = 1; i < provider.requests.length; i++) {
      const before = provider.requests[i - 1]!;
      const after = provider.requests[i]!;
      expect(after.history.slice(0, before.history.length)).toEqual(before.history); // only appended to
      expect(after.history.length).toBeGreaterThan(before.history.length);
      expect(after.options.system).toBe(before.options.system); // same system prompt
      expect(after.options.tools).toBe(before.options.tools); // the very same tool definitions
    }
  });

  test("stops after maxSteps if the model never finishes", async () => {
    const loop = Array.from({ length: 10 }, (_, i) => useTools(call(`c${i}`, "a.ts")));
    const provider = new ScriptedProvider(loop);
    const events = await run(provider, [{ role: "user", text: "go" }], { maxSteps: 3 });

    expect(provider.requests).toHaveLength(3);
    expect(events).toContainEqual({ type: "error", message: expect.stringContaining("3 steps") });
    expect(events.at(-1)).toEqual({ type: "done", reason: "max_steps" });
  });

  test("an interrupt mid-tools still answers every call, so the next request is valid", async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts"), call("c2", "b.ts"))]);
    const history: ChatTurn[] = [{ role: "user", text: "go" }];
    const events = await run(provider, history, {
      signal: controller.signal,
      runTool: async (c) => {
        controller.abort(); // the user presses ctrl+c while the first tool runs
        return fakeTool(c);
      },
    });

    expect(history.filter((t) => t.role === "tool")).toEqual([
      { role: "tool", callId: "c1", name: "read_file", text: "contents of a.ts" },
      { role: "tool", callId: "c2", name: "read_file", text: "Interrupted by the user before this tool ran." },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
  });

  test("a declined action stops the run, and later calls in the same step are answered too", async () => {
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts"), call("c2", "b.ts")), say("never asked")]);
    const history: ChatTurn[] = [{ role: "user", text: "change things" }];
    const events = await run(provider, history, {
      runTool: async (c) => ({ output: "The user declined this.", summary: "declined", declined: true, label: JSON.parse(c.arguments).path }),
    });

    expect(provider.requests).toHaveLength(1); // no further request: the user decides what's next
    expect(history.filter((t) => t.role === "tool")).toEqual([
      { role: "tool", callId: "c1", name: "read_file", text: "The user declined this." },
      { role: "tool", callId: "c2", name: "read_file", text: "Not run: the user declined an earlier action." },
    ]);
    expect(events.at(-1)).toEqual({ type: "done", reason: "declined" });
  });

  test("a provider error ends the run and is reported", async () => {
    const provider = new ScriptedProvider([[{ type: "error", message: "Rate limited" }]]);
    const events = await run(provider, [{ role: "user", text: "go" }]);
    expect(events).toEqual([
      { type: "error", message: "Rate limited" },
      { type: "done", reason: "error" },
    ]);
  });
});
