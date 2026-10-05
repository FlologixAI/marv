import { afterEach, expect, test } from "bun:test";
import { resolveConfig } from "../src/config/config.ts";
import { createProvider } from "../src/provider/index.ts";

// OpenRouter's reasoning switch: "off" must only be sent where the model's reasoning is optional
// (for a model that always reasons, OpenRouter rejects the request).
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

async function bodySent(thinking: boolean, reasoning?: "optional" | "mandatory") {
  let body: Record<string, unknown> = {};
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      body = (await req.json()) as Record<string, unknown>;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    },
  });
  const config = { ...resolveConfig({ provider: "openrouter", model: "acme/m", apiKey: "k", thinking }, {}), baseUrl: `http://localhost:${server.port}/v1` };
  for await (const _ of createProvider(config, reasoning ? { reasoning } : undefined).stream([{ role: "user", text: "hi" }]));
  server.stop(true);
  return body;
}

test("/think on turns reasoning on for models that can reason", async () => {
  expect((await bodySent(true, "optional")).reasoning).toEqual({ enabled: true });
  expect((await bodySent(true, "mandatory")).reasoning).toEqual({ enabled: true });
});

test("/think off turns it off only where it's optional", async () => {
  expect((await bodySent(false, "optional")).reasoning).toEqual({ enabled: false });
  expect((await bodySent(false, "mandatory")).reasoning).toBeUndefined();
});

test("for a model Marv knows nothing about yet, nothing is sent either way", async () => {
  expect((await bodySent(true)).reasoning).toBeUndefined();
  expect((await bodySent(false)).reasoning).toBeUndefined();
});
