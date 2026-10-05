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

  test("at the limit it asks whether to keep going: yes buys another maxSteps, no stops", async () => {
    const loop = Array.from({ length: 10 }, (_, i) => useTools(call(`c${i}`, "a.ts")));
    const provider = new ScriptedProvider(loop);
    const asked: number[] = [];
    const events = await run(provider, [{ role: "user", text: "go" }], {
      maxSteps: 2,
      onLimit: async (steps) => (asked.push(steps), steps < 4),
    });
    expect(asked).toEqual([2, 4]);
    expect(provider.requests).toHaveLength(4);
    expect(events.filter((e) => e.type === "step_limit")).toEqual([
      { type: "step_limit", steps: 2, continued: true },
      { type: "step_limit", steps: 4, continued: false },
    ]);
    expect(events).toContainEqual({ type: "error", message: 'Stopped at 4 steps, as you asked. Say "continue" to pick up where it left off.' });
    expect(events.at(-1)).toEqual({ type: "done", reason: "max_steps" });
  });

  test("it asks only after a step's tool results are in, so the history stays valid either way", async () => {
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts")), say("done")]);
    const history: ChatTurn[] = [{ role: "user", text: "go" }];
    await run(provider, history, {
      maxSteps: 1,
      onLimit: async () => {
        expect(history.at(-1)).toMatchObject({ role: "tool", callId: "c1" });
        return true;
      },
    });
    expect(history.at(-1)).toEqual({ role: "assistant", text: "done" });
  });

  test("Esc while it asks is an interrupt", async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts")), say("never")]);
    const events = await run(provider, [{ role: "user", text: "go" }], {
      maxSteps: 1,
      signal: controller.signal,
      onLimit: async () => (controller.abort(), false),
    });
    expect(provider.requests).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    expect(events.some((e) => e.type === "error")).toBe(false);
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

  describe("parallel calls", () => {
    const sub = (id: string, ms: number): ToolCall => ({ id, name: "agent", arguments: JSON.stringify({ description: id, ms }) });
    const isParallel = (c: ToolCall) => c.name === "agent";

    /** A runTool that sleeps `ms` for agent calls and records how many run at once. */
    function tracked(declineId?: string) {
      const state = { active: 0, max: 0, started: [] as string[] };
      const runTool = async (c: ToolCall) => {
        state.started.push(c.id);
        state.active++;
        state.max = Math.max(state.max, state.active);
        const { ms = 0 } = JSON.parse(c.arguments) as { ms?: number };
        await Bun.sleep(ms);
        state.active--;
        return { output: `out ${c.id}`, summary: "ok", label: c.id, ...(c.id === declineId ? { declined: true } : {}) };
      };
      return { state, runTool };
    }

    test("consecutive parallel calls run at once; results go into history in call order", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 60), sub("b", 10)), say("Both done.")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const { state, runTool } = tracked();
      const events = await run(provider, history, { runTool, isParallel });

      expect(state.max).toBe(2);
      // b finished first…
      expect(events.filter((e) => e.type === "tool_end").map((e) => e.type === "tool_end" && e.call.id)).toEqual(["b", "a"]);
      // …but the history is in call order, so every request is deterministic (prompt cache).
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.callId)).toEqual(["a", "b"]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "end" });
    });

    test("at most 4 run at once", async () => {
      const calls = Array.from({ length: 6 }, (_, i) => sub(`s${i}`, 20));
      const provider = new ScriptedProvider([useTools(...calls), say("ok")]);
      const { state, runTool } = tracked();
      await run(provider, [{ role: "user", text: "go" }], { runTool, isParallel });
      expect(state.max).toBe(4);
      expect(state.started).toHaveLength(6);
    });

    test("a non-parallel call between them splits the group", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 20), call("r", "x.ts"), sub("b", 20)), say("ok")]);
      const { state, runTool } = tracked();
      await run(provider, [{ role: "user", text: "go" }], { runTool, isParallel });
      expect(state.max).toBe(1);
      expect(state.started).toEqual(["a", "r", "b"]);
    });

    test("an interrupt answers queued calls without running them", async () => {
      const controller = new AbortController();
      const provider = new ScriptedProvider([useTools(sub("a", 10), sub("b", 10), sub("c", 10))]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const events = await run(provider, history, {
        signal: controller.signal,
        isParallel,
        maxParallel: 1,
        runTool: async (c) => {
          controller.abort();
          return { output: `out ${c.id}`, summary: "ok", label: c.id };
        },
      });
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual([
        "out a",
        "Interrupted by the user before this tool ran.",
        "Interrupted by the user before this tool ran.",
      ]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    test("a no in a parallel group lets the running ones finish, then stops", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 5), sub("b", 30)), say("never")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const { runTool } = tracked("a");
      const events = await run(provider, history, { runTool, isParallel });
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual(["out a", "out b"]);
      expect(provider.requests).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: "done", reason: "declined" });
    });

    /** Iterates the loop until the first tool_start, then stops (as a consumer whose handler throws would). */
    async function stopAtFirstToolStart(provider: Provider, opts: Partial<Parameters<typeof runAgent>[0]>) {
      for await (const event of runAgent({
        provider,
        history: [{ role: "user", text: "go" }],
        system: "SYSTEM",
        tools: SPECS,
        runTool: fakeTool,
        signal: new AbortController().signal,
        ...opts,
      }))
        if (event.type === "tool_start") break;
      await Bun.sleep(20); // anything already launched would have started by now
    }

    test("a tool doesn't start until its tool_start was delivered (single call)", async () => {
      const { state, runTool } = tracked();
      await stopAtFirstToolStart(new ScriptedProvider([useTools(call("r", "x.ts")), say("ok")]), { runTool, isParallel });
      expect(state.started).toEqual([]);
    });

    test("a tool doesn't start until its tool_start was delivered (parallel group)", async () => {
      const { state, runTool } = tracked();
      await stopAtFirstToolStart(new ScriptedProvider([useTools(sub("a", 5), sub("b", 5)), say("ok")]), { runTool, isParallel });
      expect(state.started).toEqual([]);
    });

    test("a no in a parallel group answers its queued calls without running them", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 5), sub("b", 5), sub("c", 5)), say("never")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const { state, runTool } = tracked("a");
      const events = await run(provider, history, { runTool, isParallel, maxParallel: 1 });
      expect(state.started).toEqual(["a"]);
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual([
        "out a",
        "Not run: the user declined an earlier action.",
        "Not run: the user declined an earlier action.",
      ]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "declined" });
    });

    test("a tool that throws or rejects in a group becomes an error result, and the run goes on", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 0), sub("b", 0), sub("c", 0)), say("Recovered.")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const runTool = (c: ToolCall): Promise<ToolResult & { label: string }> => {
        if (c.id === "a") throw new Error("boom");
        if (c.id === "b") return Promise.reject("not an Error");
        return Promise.resolve({ output: "out c", summary: "ok", label: "c" });
      };
      const events = await run(provider, history, { runTool, isParallel });
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual([
        "agent failed: boom",
        "agent failed: not an Error",
        "out c",
      ]);
      expect(provider.requests).toHaveLength(2);
      expect(events.at(-1)).toEqual({ type: "done", reason: "end" });
    });

    test("after an interrupt, reserved and queued calls are answered without a tool_start", async () => {
      const controller = new AbortController();
      const provider = new ScriptedProvider([useTools(sub("a", 10), sub("b", 10), sub("c", 10))]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const started: string[] = [];
      const events = await run(provider, history, {
        signal: controller.signal,
        isParallel,
        maxParallel: 2,
        runTool: async (c) => {
          started.push(c.id);
          controller.abort();
          await Bun.sleep(10);
          return { output: `out ${c.id}`, summary: "ok", label: c.id };
        },
      });
      // b had a slot too, but the interrupt came before its tool_start was delivered.
      expect(started).toEqual(["a"]);
      expect(events.filter((e) => e.type === "tool_start").map((e) => e.type === "tool_start" && e.call.id)).toEqual(["a"]);
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual([
        "out a",
        "Interrupted by the user before this tool ran.",
        "Interrupted by the user before this tool ran.",
      ]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    test("a call after a declined parallel group isn't run", async () => {
      const provider = new ScriptedProvider([useTools(sub("a", 5), sub("b", 5), call("r", "x.ts")), say("never")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const { state, runTool } = tracked("a");
      const events = await run(provider, history, { runTool, isParallel });
      expect(state.started).toEqual(["a", "b"]);
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual([
        "out a",
        "out b",
        "Not run: the user declined an earlier action.",
      ]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "declined" });
    });

    // Esc at an approval declines what's waiting and aborts the run: the model must read that as an
    // interrupt, not as the user saying no to those calls.
    const escOn = (controller: AbortController, id: string) => async (c: ToolCall) => {
      if (c.id === id) controller.abort();
      await Bun.sleep(5);
      return { output: `out ${c.id}`, summary: "ok", label: c.id, ...(c.id === id ? { declined: true } : {}) };
    };

    test("after Esc (a decline and an abort), a group's queued calls read as interrupted", async () => {
      const controller = new AbortController();
      const provider = new ScriptedProvider([useTools(sub("a", 5), sub("b", 5), sub("c", 5)), say("never")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      const events = await run(provider, history, { signal: controller.signal, runTool: escOn(controller, "a"), isParallel, maxParallel: 1 });
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual([
        "out a",
        "Interrupted by the user before this tool ran.",
        "Interrupted by the user before this tool ran.",
      ]);
      expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    });

    test("after Esc, the calls after the group read as interrupted too", async () => {
      const controller = new AbortController();
      const provider = new ScriptedProvider([useTools(sub("a", 5), call("r", "x.ts")), say("never")]);
      const history: ChatTurn[] = [{ role: "user", text: "go" }];
      await run(provider, history, { signal: controller.signal, runTool: escOn(controller, "a"), isParallel });
      expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual([
        "out a",
        "Interrupted by the user before this tool ran.",
      ]);
    });

    test("an agent call is labeled with its type and description while it runs", async () => {
      const typed: ToolCall = { id: "t", name: "agent", arguments: JSON.stringify({ type: "explore", description: "Find the config" }) };
      const provider = new ScriptedProvider([useTools(sub("Read notes", 0), typed), say("ok")]);
      const { runTool } = tracked();
      const events = await run(provider, [{ role: "user", text: "go" }], { runTool, isParallel });
      expect(events.filter((e) => e.type === "tool_start").map((e) => e.type === "tool_start" && e.label)).toEqual([
        "general-purpose · Read notes",
        "explore · Find the config",
      ]);
    });
  });
});
