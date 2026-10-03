import { describe, expect, test } from "bun:test";
import { formatPrice, listModels } from "../src/provider/models.ts";

/** A fetch that answers from a table of URL → JSON body. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: { url: string; body?: string }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body as string | undefined });
    const key = init?.body ? `${url} ${init.body}` : url;
    if (!(key in routes)) return new Response("not found", { status: 404 });
    return Response.json(routes[key]);
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

describe("listModels", () => {
  test("OpenRouter: tool-capable chat models with prices per million tokens", async () => {
    const fetch = fakeFetch({
      "https://openrouter.ai/api/v1/models": {
        data: [
          {
            id: "anthropic/claude-sonnet-5.5",
            context_length: 1000000,
            pricing: { prompt: "0.000002", completion: "0.00001" },
            supported_parameters: ["tools", "temperature"],
          },
          { id: "some/image-model", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
          { id: "anthropic/claude-sonnet-5.5:batch", supported_parameters: ["tools"] },
        ],
      },
    });
    expect(await listModels({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }, fetch)).toEqual([
      { id: "anthropic/claude-sonnet-5.5", tools: true, priceIn: 2, priceOut: 10, context: 1000000 },
    ]);
  });

  test("Ollama: local models, with tool support read from /api/show", async () => {
    const fetch = fakeFetch({
      "http://localhost:11434/api/tags": { models: [{ name: "qwen3.5:9b" }, { name: "tiny:1b" }] },
      'http://localhost:11434/api/show {"model":"qwen3.5:9b"}': { capabilities: ["completion", "tools"] },
      'http://localhost:11434/api/show {"model":"tiny:1b"}': { capabilities: ["completion"] },
    });
    expect(await listModels({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }, fetch)).toEqual([
      { id: "qwen3.5:9b", tools: true, local: true },
      { id: "tiny:1b", tools: false, local: true },
    ]);
  });

  test("a failed request becomes a readable error", async () => {
    const fetch = fakeFetch({});
    await expect(listModels({ provider: "ollama", baseUrl: "http://localhost:11434/v1" }, fetch)).rejects.toThrow(
      "http://localhost:11434/api/tags returned 404",
    );
  });
});

test("formatPrice shows $ per million tokens, in and out", () => {
  expect(formatPrice({ id: "x", priceIn: 2, priceOut: 10 })).toBe("$2 / $10");
  expect(formatPrice({ id: "x", priceIn: 0.0188, priceOut: 1.28 })).toBe("$0.019 / $1.28");
  expect(formatPrice({ id: "x", priceIn: 0, priceOut: 0 })).toBe("free");
  expect(formatPrice({ id: "x", local: true })).toBe("local");
});
