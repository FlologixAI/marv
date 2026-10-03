import { PRESETS, type Config } from "../config/config.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";
import type { Provider } from "./types.ts";

// The one place that maps a config to a concrete Provider.
// OpenRouter and Ollama are the same adapter pointed at different URLs.
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
      return new OpenAICompatProvider({
        name: `ollama · ${config.model}`,
        label: PRESETS.ollama.label,
        baseUrl: config.baseUrl,
        model: config.model,
        offlineHint: "Is Ollama running? Start it with `ollama serve`.",
        // Local thinking models can reason for minutes; "none" makes them answer directly.
        body: config.thinking ? {} : { reasoning_effort: "none" },
      });
  }
}
