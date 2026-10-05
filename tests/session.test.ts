import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpManager } from "../src/mcp/manager.ts";
import { addMemory, loadMemory, memoryPaths } from "../src/memory.ts";
import type { ProviderFactory } from "../src/provider/factory.ts";
import type { AgentEvent, ChatTurn, Provider, StreamOptions, ToolCall, ToolSpec } from "../src/provider/types.ts";
import { MarvSession, type SessionEvent, type SessionInit } from "../src/session.ts";
import { SessionStore, type SavedSession } from "../src/sessions.ts";
import { TrajectoryStore } from "../src/trajectory.ts";
import type { ApprovalRequest, Decision } from "../src/tools/types.ts";
import { RoutedProvider, ScriptedProvider } from "./fake-provider.ts";

const say = (text: string): AgentEvent[] => [
  { type: "text_delta", text },
  { type: "done", reason: "stop" },
];
const useTools = (...calls: ToolCall[]): AgentEvent[] => [...calls.map((c) => ({ type: "tool_call" as const, call: c })), { type: "done", reason: "tool_calls" }];
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const read = (id: string) => call(id, "read_file", { path: "notes.txt" });
const fixed = (provider: Provider, extra: Partial<ProviderFactory> = {}): ProviderFactory => ({ id: "test", model: "test-model", make: () => provider, ...extra });

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
const types = (events: SessionEvent[]) => events.map((e) => e.type);

/** Tool calls in a history without a result: a request with one is rejected by the API. */
function unanswered(history: ChatTurn[]): string[] {
  const calls = history.flatMap((t) => (t.role === "assistant" ? (t.toolCalls ?? []).map((c) => c.id) : []));
  const answered = new Set(history.flatMap((t) => (t.role === "tool" ? [t.callId] : [])));
  return calls.filter((id) => !answered.has(id));
}

/** A model that says something, then works until it's stopped. */
class Hanging implements Provider {
  readonly name = "hanging";
  requests = 0;
  async *stream(_history: ChatTurn[], { signal }: StreamOptions = {}): AsyncIterable<AgentEvent> {
    this.requests++;
    yield { type: "text_delta", text: "Working" };
    await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
    yield { type: "done" };
  }
}

let project: string;
let dir: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "marv-session-project-"));
  dir = await mkdtemp(join(tmpdir(), "marv-session-"));
  await writeFile(join(project, "notes.txt"), "remember the milk\n");
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

function makeSession(provider: Provider | ProviderFactory, init: Partial<SessionInit> = {}): MarvSession {
  return new MarvSession({ root: project, provider: "make" in provider ? provider : fixed(provider), ...init });
}

describe("a turn", () => {
  test("starts with turn_start, ends with turn_end, and streams the reply in between", async () => {
    const events = await collect(makeSession(new ScriptedProvider([say("Hello.")])).send("hi"));
    expect(types(events)).toEqual(["turn_start", "status", "text_delta", "assistant", "done", "turn_end"]);
    const start = events[0] as Extract<SessionEvent, { type: "turn_start" }>;
    expect(events.at(-1)).toEqual({ type: "turn_end", turn: start.turn, reason: "end" });
  });

  test("one at a time: send() during a turn throws; the next can start once it ended", async () => {
    const provider = new ScriptedProvider([say("One."), say("Two.")]);
    const session = makeSession(provider);
    const first = session.send("one");
    expect(session.busy).toBe(true);
    expect(() => session.send("two")).toThrow(/working/);
    await collect(first);
    expect(session.busy).toBe(false);
    await collect(session.send("two"));
    expect(provider.requests.map((r) => r.history.at(-1)?.text)).toEqual(["one", "two"]);
  });

  test("interrupt() stops the running turn", async () => {
    const session = makeSession(new Hanging());
    const events: SessionEvent[] = [];
    for await (const event of session.send("go")) {
      events.push(event);
      if (event.type === "text_delta") session.interrupt();
    }
    expect(events).toContainEqual({ type: "done", reason: "aborted" });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
  });

  test("so does the signal passed to send()", async () => {
    const stop = new AbortController();
    const events: SessionEvent[] = [];
    for await (const event of makeSession(new Hanging()).send("go", { signal: stop.signal })) {
      events.push(event);
      if (event.type === "text_delta") stop.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
  });

  test("leaving the loop early interrupts the turn, and every tool call still gets a result", async () => {
    const provider = new ScriptedProvider([useTools(read("c1"), read("c2")), say("Next.")]);
    const session = makeSession(provider);
    for await (const event of session.send("read it twice")) if (event.type === "tool_start") break;
    expect(session.busy).toBe(false);
    await collect(session.send("next"));
    expect(unanswered(provider.requests[1]!.history)).toEqual([]);
  });

  test("usage adds up, and the last request's size is kept", async () => {
    const provider = new ScriptedProvider([[{ type: "usage", usage: { promptTokens: 100, completionTokens: 20 } }, ...say("Hi.")]]);
    const session = makeSession(fixed(provider, { local: true }));
    await collect(session.send("hi"));
    expect(session.usage()).toMatchObject({
      last: { promptTokens: 100, completionTokens: 20 },
      totals: { requests: 1, promptTokens: 100, completionTokens: 20, local: true },
    });
  });

  test("a provider error ends the turn with reason error", async () => {
    const events = await collect(makeSession(new ScriptedProvider([[{ type: "error", message: "bad key" }]])).send("hi"));
    expect(events).toContainEqual({ type: "error", message: "bad key" });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "error" });
  });

  test("a provider that throws ends the turn, not the session", async () => {
    const broken: Provider = {
      name: "broken",
      stream: () => {
        throw new Error("kaput");
      },
    };
    const session = makeSession(broken);
    const events = await collect(session.send("hi"));
    expect(events).toContainEqual({ type: "error", message: "Error: kaput" });
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "error" });
    expect(session.busy).toBe(false);
  });

  test("systemPrompt replaces Marv's, or adds to it", async () => {
    const replaced = new ScriptedProvider([say("ok")]);
    await collect(makeSession(replaced, { systemPrompt: "You are a pirate." }).send("hi"));
    expect(replaced.requests[0]!.options.system).toBe("You are a pirate.");
    const appended = new ScriptedProvider([say("ok")]);
    await collect(makeSession(appended, { systemPrompt: { append: "Answer briefly." } }).send("hi"));
    expect(appended.requests[0]!.options.system).toStartWith("You are Marv");
    expect(appended.requests[0]!.options.system).toEndWith("Answer briefly.");
  });
});

describe("approvals", () => {
  test("without an approver, a yolo-safe edit runs, anything else is refused, and the turn goes on", async () => {
    const provider = new ScriptedProvider([
      useTools(call("c1", "write_file", { path: "a.txt", content: "hi\n" }), call("c2", "bash", { command: "curl example.com", network: true })),
      say("Done."),
    ]);
    const events = await collect(makeSession(provider).send("go"));
    expect(await readFile(join(project, "a.txt"), "utf8")).toBe("hi\n");
    const refused = events.find((e) => e.type === "tool_end" && e.call.id === "c2");
    expect(refused).toMatchObject({ result: { isError: true, output: expect.stringContaining("no one to ask") } });
    expect(events).toContainEqual({ type: "done", reason: "end" });
  });

  test("'always' covers that scope for the rest of the session, later turns included", async () => {
    const asked: string[] = [];
    const provider = new ScriptedProvider([
      useTools(call("c1", "write_file", { path: "a.txt", content: "1" })),
      say("One."),
      useTools(call("c2", "write_file", { path: "b.txt", content: "2" })),
      say("Two."),
    ]);
    const session = makeSession(provider, { yolo: false, approve: async (r) => (asked.push(r.label), "always") });
    await collect(session.send("one"));
    await collect(session.send("two"));
    expect(asked).toEqual(["a.txt"]);
    expect(existsSync(join(project, "b.txt"))).toBe(true);
  });

  test("stopping the turn answers a pending approval with no", async () => {
    const provider = new ScriptedProvider([useTools(call("c1", "write_file", { path: "a.txt", content: "1" }))]);
    let session: MarvSession | undefined;
    session = makeSession(provider, {
      yolo: false,
      approve: () => {
        session!.interrupt();
        return new Promise<Decision>(() => {}); // never answers: only the stop can
      },
    });
    const events = await collect(session.send("go"));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", result: expect.objectContaining({ declined: true, summary: "interrupted" }) }));
    expect(existsSync(join(project, "a.txt"))).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "aborted" });
  });

  test("without an approver it stops at the step limit", async () => {
    const provider = new ScriptedProvider(Array.from({ length: 30 }, (_, i) => useTools(read(`c${i}`))));
    const events = await collect(makeSession(provider).send("loop"));
    expect(provider.requests).toHaveLength(25);
    expect(events).toContainEqual({ type: "done", reason: "max_steps" });
  });

  test("with an approver it asks at the step limit, in the continue scope", async () => {
    const provider = new ScriptedProvider(Array.from({ length: 30 }, (_, i) => useTools(read(`c${i}`))));
    const asked: ApprovalRequest[] = [];
    const events = await collect(makeSession(provider, { approve: async (r) => (asked.push(r), "no") }).send("loop"));
    expect(asked.map((r) => r.scope.key)).toEqual(["continue"]);
    expect(events).toContainEqual({ type: "step_limit", steps: 25, continued: false });
  });
});
