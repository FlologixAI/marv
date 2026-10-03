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
      { type: "done" },
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
        { system: "You are ekko." },
      ),
    );
    expect(lastRequest!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(lastRequest!.body).toEqual({
      model: "acme/model-1",
      stream: true,
      messages: [
        { role: "system", content: "You are ekko." },
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
