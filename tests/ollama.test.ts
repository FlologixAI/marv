import { afterEach, describe, expect, test } from "bun:test";
import { OllamaProvider } from "../src/provider/ollama.ts";
import type { AgentEvent } from "../src/provider/types.ts";

// A local stand-in for Ollama's native /api/chat.
let server: ReturnType<typeof Bun.serve> | undefined;
let lastRequest: { path: string; body: any } | undefined;

function serve(respond: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastRequest = { path: new URL(req.url).pathname, body: await req.clone().json() };
      return respond(req);
    },
  });
  return `http://localhost:${server.port}`;
}
afterEach(() => server?.stop(true));

/** Ollama streams one JSON object per line. */
const ndjson = (...lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const msg = (message: Record<string, unknown>) => ({ message: { role: "assistant", content: "", ...message }, done: false });
const end = { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 298, eval_count: 26 };

function provider(baseUrl: string, thinking = false) {
  return new OllamaProvider({ baseUrl, model: "qwen3.5:9b", contextLength: 32768, thinking });
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OllamaProvider", () => {
  test("streams thinking and text, then usage and done", async () => {
    const url = serve(() => ndjson(msg({ thinking: "Hmm." }), msg({ content: "Hel" }), msg({ content: "lo" }), end));
    expect(await collect(provider(url).stream([{ role: "user", text: "hi" }]))).toEqual([
      { type: "thinking_delta", text: "Hmm." },
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "usage", usage: { promptTokens: 298, completionTokens: 26 } },
      { type: "done", reason: "stop" },
    ]);
  });

  test("turns tool calls (arguments as an object) into ekko's ToolCalls", async () => {
    const url = serve(() =>
      ndjson(msg({ tool_calls: [{ id: "call_x", function: { index: 0, name: "read_file", arguments: { path: "package.json" } } }] }), end),
    );
    const events = await collect(provider(url).stream([{ role: "user", text: "read it" }]));
    expect(events).toContainEqual({ type: "tool_call", call: { id: "call_x", name: "read_file", arguments: '{"path":"package.json"}' } });
  });

  test("asks for the context size and thinking setting, and sends history in Ollama's format", async () => {
    const url = serve(() => ndjson(end));
    const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }];
    await collect(
      provider(url, true).stream(
        [
          { role: "user", text: "read it" },
          { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
          { role: "tool", callId: "c1", name: "read_file", text: "contents" },
        ],
        { system: "You are ekko.", tools },
      ),
    );
    expect(lastRequest!.path).toBe("/api/chat");
    expect(lastRequest!.body).toEqual({
      model: "qwen3.5:9b",
      stream: true,
      think: true,
      options: { num_ctx: 32768 },
      messages: [
        { role: "system", content: "You are ekko." },
        { role: "user", content: "read it" },
        { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }] },
        { role: "tool", tool_name: "read_file", content: "contents" },
      ],
      tools: [{ type: "function", function: tools[0] }],
    });
  });

  test("accepts a base URL with a trailing /v1 (older configs)", async () => {
    const url = serve(() => ndjson(end));
    await collect(provider(`${url}/v1`).stream([{ role: "user", text: "hi" }]));
    expect(lastRequest!.path).toBe("/api/chat");
  });

  test("reports a missing model and a mid-stream error", async () => {
    let url = serve(() => Response.json({ error: "model 'nope' not found" }, { status: 404 }));
    expect((await collect(provider(url).stream([{ role: "user", text: "hi" }])))[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining('wasn\'t found on Ollama'),
    });
    server!.stop(true);

    url = serve(() => ndjson(msg({ content: "par" }), { error: "out of memory" }));
    expect(await collect(provider(url).stream([{ role: "user", text: "hi" }]))).toEqual([
      { type: "text_delta", text: "par" },
      { type: "error", message: "Ollama: out of memory" },
    ]);
  });

  test("explains when Ollama isn't running", async () => {
    const events = await collect(provider("http://localhost:1").stream([{ role: "user", text: "hi" }]));
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("Is Ollama running?") }]);
  });

  test("exposes its context size", () => {
    expect(provider("http://localhost:11434").contextLength).toBe(32768);
  });
});
