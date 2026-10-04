import { PRESETS, type Config } from "../config/config.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";
import type { Provider } from "./types.ts";

// The one place that maps a config to a concrete Provider.
export function createProvider(config: Config): Provider {
  switch (config.provider) {
    case "openrouter":
      return new OpenAICompatProvider({
        name: `openrouter · ${config.model}`,
        label: PRESETS.openrouter.label,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
        // Optional attribution: shows "ekko" in your OpenRouter activity log.
        headers: { "X-Title": "ekko" },
      });
    case "ollama":
      // Ollama's native API, so we can set the context window (its default is 4096 tokens).
      return new OllamaProvider({
        baseUrl: config.baseUrl,
        model: config.model,
        contextLength: config.contextLength,
        thinking: config.thinking,
      });
  }
}
