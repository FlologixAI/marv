import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import type { ProviderId } from "../src/config/config.ts";
import type { ModelInfo } from "../src/provider/models.ts";
import { filterModels } from "../src/ui/ModelPicker.tsx";
import { Setup } from "../src/ui/Setup.tsx";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const tick = (ms = 30) => Bun.sleep(ms);

async function press(stdin: { write: (data: string) => void }, ...keys: string[]) {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
}

const MODELS: Record<ProviderId, ModelInfo[]> = {
  openrouter: [
    { id: "anthropic/claude-sonnet-5.5", tools: true, priceIn: 2, priceOut: 10 },
    { id: "deepseek/deepseek-v4.1-flash", tools: true, priceIn: 0.3, priceOut: 1.2 },
    { id: "z-ai/glm-5.3", tools: true, priceIn: 0.22, priceOut: 3.39 },
  ],
  ollama: [
    { id: "qwen3.5:9b", tools: true, local: true },
    { id: "tiny:1b", tools: false, local: true },
  ],
};
const loadModels = async (provider: ProviderId) => MODELS[provider];

function renderSetup(props: Partial<Parameters<typeof Setup>[0]> = {}) {
  const onComplete = mock();
  const onCancel = mock();
  const result = render(
    <Setup initial={null} env={{}} loadModels={loadModels} onComplete={onComplete} onCancel={onCancel} {...props} />,
  );
  return { ...result, onComplete, onCancel };
}

describe("Setup", () => {
  test("OpenRouter: provider → filtered model → key", async () => {
    const { stdin, lastFrame, onComplete } = renderSetup();
    await tick();
    expect(lastFrame()).toContain("Which AI provider");
    await press(stdin, ENTER); // OpenRouter (default)

    expect(lastFrame()).toContain("Which model?");
    expect(lastFrame()).toContain("$2 / $10");
    await press(stdin, "deep", ENTER);

    expect(lastFrame()).toContain("Paste your OpenRouter API key");
    await press(stdin, "sk-or-secret", ENTER);
    expect(lastFrame()).not.toContain("sk-or-secret"); // input is masked
    expect(onComplete).toHaveBeenCalledWith({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", apiKey: "sk-or-secret" });
  });

  test("skips the key step when OPENROUTER_API_KEY is set", async () => {
    const { stdin, lastFrame, onComplete } = renderSetup({ env: { OPENROUTER_API_KEY: "sk-or-from-env-123456" } });
    await tick();
    await press(stdin, ENTER);
    expect(lastFrame()).toContain("Using OPENROUTER_API_KEY");
    await press(stdin, ENTER); // the default model is highlighted
    expect(onComplete).toHaveBeenCalledWith({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5" });
  });

  test("Ollama: lists local models, flags ones without tools, needs no key", async () => {
    const { stdin, lastFrame, onComplete } = renderSetup();
    await tick();
    await press(stdin, DOWN, ENTER);
    expect(lastFrame()).toContain("qwen3.5:9b");
    expect(lastFrame()).toContain("no tool support");
    await press(stdin, ENTER);
    expect(onComplete).toHaveBeenCalledWith({ provider: "ollama", model: "qwen3.5:9b" });
  });

  test("Enter with no matches uses the typed text as a model ID", async () => {
    const { stdin, onComplete } = renderSetup({ env: { OPENROUTER_API_KEY: "k" } });
    await tick();
    await press(stdin, ENTER, "acme/brand-new-model", ENTER);
    expect(onComplete).toHaveBeenCalledWith({ provider: "openrouter", model: "acme/brand-new-model" });
  });

  test("a failed model list still lets you type an ID", async () => {
    const { stdin, lastFrame, onComplete } = renderSetup({
      loadModels: async () => {
        throw new Error("connection refused");
      },
    });
    await tick();
    await press(stdin, DOWN, ENTER);
    expect(lastFrame()).toContain("Couldn't load models: connection refused");
    await press(stdin, "llama3:8b", ENTER);
    expect(onComplete).toHaveBeenCalledWith({ provider: "ollama", model: "llama3:8b" });
  });

  test("only real providers are offered", async () => {
    const { lastFrame } = renderSetup();
    await tick();
    expect(lastFrame()).toContain("OpenRouter");
    expect(lastFrame()).toContain("Ollama");
    expect(lastFrame()).not.toContain("Echo");
  });

  test("Enter on an empty key keeps the saved one", async () => {
    const initial = { provider: "openrouter" as const, model: "z-ai/glm-5.3", apiKey: "sk-or-saved-key-0000" };
    const { stdin, onComplete } = renderSetup({ initial });
    await tick();
    await press(stdin, ENTER, ENTER, ENTER); // provider, model (current one highlighted), key
    expect(onComplete).toHaveBeenCalledWith(initial);
  });

  test("/model mode: just the picker, keeps the key and endpoint", async () => {
    const initial = { provider: "ollama" as const, model: "tiny:1b", baseUrl: "http://gpu:11434/v1" };
    const { stdin, lastFrame, onComplete } = renderSetup({ initial, startStep: "model" });
    await tick();
    expect(lastFrame()).toContain("Switch Ollama model");
    await press(stdin, "qwen", ENTER);
    expect(onComplete).toHaveBeenCalledWith({ provider: "ollama", model: "qwen3.5:9b", baseUrl: "http://gpu:11434/v1" });
  });

  test("Esc cancels", async () => {
    const { stdin, onCancel } = renderSetup();
    await tick();
    await press(stdin, ESC);
    await tick(100); // a lone ESC is held briefly to tell it apart from escape sequences
    expect(onCancel).toHaveBeenCalled();
  });
});

test("filterModels matches every term, in any order", () => {
  const ids = filterModels(MODELS.openrouter, "SONNET claude").map((m) => m.id);
  expect(ids).toEqual(["anthropic/claude-sonnet-5.5"]);
});
