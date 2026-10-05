import { afterEach, describe, expect, test } from "bun:test";
import { OpenAICompatProvider } from "../src/provider/openai-compat.ts";
import type { AgentEvent } from "../src/provider/types.ts";

// A local stand-in for OpenRouter/Ollama: each test decides how it responds.
let server: ReturnType<typeof Bun.serve> | undefined;
let lastRequest: { headers: Headers; body: any } | undefined;

function serve(respond: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastRequest = { headers: req.headers, body: await req.clone().json() };
      return respond(req);
    },
  });
  return `http://localhost:${server.port}/v1`;
}
afterEach(() => server?.stop(true));

const sse = (...events: unknown[]) =>
  new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
const delta = (content: string) => ({ choices: [{ delta: { content } }] });

function provider(baseUrl: string, apiKey?: string, body?: Record<string, unknown>) {
  return new OpenAICompatProvider({ name: "test", label: "TestRouter", baseUrl, model: "acme/model-1", apiKey, body });
}

async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OpenAICompatProvider", () => {
  test("streams text deltas and ends with done", async () => {
    const url = serve(() => sse(delta("Hel"), delta("lo"), { choices: [{ delta: {}, finish_reason: "stop" }] }, "[DONE]"));
    expect(await collect(provider(url).stream([{ role: "user", text: "hi" }]))).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "done", reason: "stop" },
    ]);
  });

  test("sends the model, system prompt, history, and key", async () => {
    const url = serve(() => sse("[DONE]"));
    await collect(
      provider(url, "sk-test").stream(
        [
          { role: "user", text: "hi" },
          { role: "assistant", text: "hello" },
          { role: "user", text: "again" },
        ],
        { system: "You are Marv." },
      ),
    );
    expect(lastRequest!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(lastRequest!.body).toEqual({
      model: "acme/model-1",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "You are Marv." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "again" },
      ],
    });
  });

  test("streams reasoning as thinking deltas, from either field name", async () => {
    const url = serve(() =>
      sse({ choices: [{ delta: { reasoning: "Hmm, " } }] }, { choices: [{ delta: { reasoning_content: "ok." } }] }, delta("Hi!"), "[DONE]"),
    );
    expect(await collect(provider(url).stream([{ role: "user", text: "hi" }]))).toEqual([
      { type: "thinking_delta", text: "Hmm, " },
      { type: "thinking_delta", text: "ok." },
      { type: "text_delta", text: "Hi!" },
      { type: "done" },
    ]);
  });

  test("adds extra body fields to the request", async () => {
    const url = serve(() => sse("[DONE]"));
    await collect(provider(url, undefined, { reasoning_effort: "none" }).stream([{ role: "user", text: "hi" }]));
    expect(lastRequest!.body.reasoning_effort).toBe("none");
  });

  test("sends tools, and tool calls and results in OpenAI's format", async () => {
    const url = serve(() => sse("[DONE]"));
    const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }];
    await collect(
      provider(url).stream(
        [
          { role: "user", text: "read it" },
          { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }] },
          { role: "tool", callId: "c1", name: "read_file", text: "file contents" },
        ],
        { tools },
      ),
    );
    expect(lastRequest!.body.tools).toEqual([{ type: "function", function: tools[0] }]);
    expect(lastRequest!.body.messages).toEqual([
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "file contents" },
    ]);
  });

  test("reassembles tool calls streamed in fragments", async () => {
    const tc = (tool_calls: unknown) => ({ choices: [{ delta: { tool_calls } }] });
    const url = serve(() =>
      sse(
        tc([{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: "" } }]),
        tc([{ index: 0, function: { arguments: '{"pa' } }]),
        tc([{ index: 1, id: "c2", type: "function", function: { name: "glob", arguments: '{"pattern":"*"}' } }]),
        tc([{ index: 0, function: { arguments: 'th":"a.ts"}' } }]),
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 }, cost: 0.00042 } },
        "[DONE]",
      ),
    );
    expect(await collect(provider(url).stream([{ role: "user", text: "go" }]))).toEqual([
      { type: "usage", usage: { promptTokens: 1200, completionTokens: 30, cachedTokens: 1000, cost: 0.00042 } },
      { type: "tool_call", call: { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' } },
      { type: "tool_call", call: { id: "c2", name: "glob", arguments: '{"pattern":"*"}' } },
      { type: "done", reason: "tool_calls" },
    ]);
  });

  test("sends no Authorization header without a key (Ollama)", async () => {
    const url = serve(() => sse("[DONE]"));
    await collect(provider(url).stream([{ role: "user", text: "hi" }]));
    expect(lastRequest!.headers.get("authorization")).toBeNull();
  });

  test.each([
    [401, "TestRouter rejected the API key"],
    [402, "out of credits"],
    [404, 'Model "acme/model-1" wasn\'t found'],
    [429, "Rate limited"],
    [503, "TestRouter is having trouble (503)"],
  ])("turns HTTP %d into a helpful error", async (status, message) => {
    const url = serve(() => Response.json({ error: { message: "upstream says no" } }, { status }));
    const events = await collect(provider(url).stream([{ role: "user", text: "hi" }]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain(message);
    expect((events[0] as { message: string }).message).toContain("upstream says no");
  });

  test("reports an error sent in the middle of the stream", async () => {
    const url = serve(() => sse(delta("partial"), { error: { message: "provider crashed" } }));
    expect(await collect(provider(url).stream([{ role: "user", text: "hi" }]))).toEqual([
      { type: "text_delta", text: "partial" },
      { type: "error", message: "TestRouter: provider crashed" },
    ]);
  });

  test("an upstream failure wrapped by OpenRouter shows the provider's own message", async () => {
    const wrapped = { error: { message: "Provider returned error", code: 400, metadata: { provider_name: "Anthropic", raw: '{"type":"error","error":{"message":"tool_use ids must be unique"}}' } } };
    const http = serve(() => Response.json(wrapped, { status: 400 }));
    const [event] = await collect(provider(http).stream([{ role: "user", text: "hi" }]));
    const message = (event as { type: string; message: string }).message;
    expect(event?.type).toBe("error");
    expect(message).toContain("Anthropic");
    expect(message).toContain("tool_use ids must be unique");
    server!.stop(true);
    const midStream = serve(() => sse(delta("partial"), wrapped));
    const events = await collect(provider(midStream).stream([{ role: "user", text: "hi" }]));
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("tool_use ids must be unique") });
  });

  test("an HTML error page (a gateway's 502) isn't dumped into the transcript", async () => {
    const page = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>${"x".repeat(8000)}</body></html>`;
    const url = serve(() => new Response(page, { status: 502, statusText: "Bad Gateway", headers: { "content-type": "text/html" } }));
    const [event] = await collect(provider(url).stream([{ role: "user", text: "hi" }]));
    const message = (event as { message: string }).message;
    expect(message).toStartWith("TestRouter is having trouble (502).");
    expect(message).not.toContain("<");
    expect(message.length).toBeLessThan(200);
  });

  test("a stream that ends before the reply is complete is an error, not a finished reply", async () => {
    const toolFragment = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: '{"path":"a.ts","con' } }] } }] };
    const url = serve(() => sse(delta("Writing the fi"), toolFragment)); // a proxy closed it: no finish_reason, no [DONE]
    const events = await collect(provider(url).stream([{ role: "user", text: "hi" }]));
    expect(events.map((e) => e.type)).toEqual(["text_delta", "error"]); // the cut-off call never runs
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("ended early") });
  });

  test("explains when the server can't be reached", async () => {
    const events = await collect(provider("http://localhost:1/v1").stream([{ role: "user", text: "hi" }]));
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("Can't reach TestRouter at http://localhost:1") }]);
  });

  test("stops quietly when aborted mid-stream", async () => {
    const encoder = new TextEncoder();
    const url = serve(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta("first"))}\n\n`));
              await Bun.sleep(5000); // never finishes on its own
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of provider(url).stream([{ role: "user", text: "hi" }], { signal: controller.signal })) {
      events.push(event);
      controller.abort();
    }
    expect(events).toEqual([{ type: "text_delta", text: "first" }]);
  });
});
