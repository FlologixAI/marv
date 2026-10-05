import { expect, test } from "bun:test";
import { resolveConfig } from "../src/config/config.ts";
import { configFactory, isFactory, providerFactory, type ProviderOption } from "../src/provider/factory.ts";
import { OllamaProvider } from "../src/provider/ollama.ts";
import { OpenAICompatProvider } from "../src/provider/openai-compat.ts";
import { ScriptedProvider } from "./fake-provider.ts";

test("an OpenRouter option makes an OpenRouter provider, and can look the model up", () => {
  const factory = providerFactory({ kind: "openrouter", apiKey: "sk-test", model: "x/y" });
  expect(factory).toMatchObject({ id: "openrouter", model: "x/y", local: false });
  const provider = factory.make();
  expect(provider).toBeInstanceOf(OpenAICompatProvider);
  expect(provider.name).toBe("openrouter · x/y");
  expect(factory.lookup).toBeDefined();
});

test("an Ollama option is local, with its host and context window, and nothing to look up", () => {
  const factory = providerFactory({ kind: "ollama", model: "qwen3.5:9b", host: "gpu-box:11434", contextLength: 65536 });
  expect(factory).toMatchObject({ id: "ollama", model: "qwen3.5:9b", local: true });
  const provider = factory.make();
  expect(provider).toBeInstanceOf(OllamaProvider);
  expect(provider.contextLength).toBe(65536);
  expect(factory.lookup).toBeUndefined();
});

test("a Provider of your own is used as is, also for subagents", () => {
  const own = new ScriptedProvider([]);
  const factory = providerFactory(own);
  expect(factory).toMatchObject({ id: "custom", model: "scripted" });
  expect(factory.make()).toBe(own);
  expect(factory.make("another/model")).toBe(own);
});

test("configFactory: the TUI's config, with the maker and model list it was given", async () => {
  const config = { ...resolveConfig({ provider: "openrouter", model: "a/b", apiKey: "k" }, {}), thinking: true };
  const made: unknown[] = [];
  const factory = configFactory(
    config,
    (c, info) => (made.push([c.model, c.thinking, info]), new ScriptedProvider([])),
    async () => [{ id: "a/b", context: 1000 }, { id: "c/d" }],
  );
  factory.make();
  factory.make("c/d");
  factory.make(undefined, { reasoning: "optional" });
  expect(made).toEqual([
    ["a/b", true, undefined],
    ["c/d", true, undefined],
    ["a/b", true, { reasoning: "optional" }],
  ]);
  expect(await factory.lookup!()).toEqual({ id: "a/b", context: 1000 });
  expect(isFactory(factory)).toBe(true);
  expect(isFactory(new ScriptedProvider([]))).toBe(false);
});

test("an unknown kind is an error, not a silent Ollama on localhost", () => {
  const bad = { kind: "OpenRouter", apiKey: "k" } as unknown as ProviderOption;
  expect(() => providerFactory(bad)).toThrow('Unknown provider kind "OpenRouter": use "openrouter" or "ollama", or pass a Provider.');
});
