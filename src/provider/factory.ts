// How a session gets its providers. It needs more than one Provider object: a subagent type can name another
// model, and on OpenRouter the provider is remade once the model list says whether the model's reasoning can be
// turned off (/think). A factory makes them, and says what to record in saved sessions and trajectories.
import { resolveConfig, type Config } from "../config/config.ts";
import { createProvider } from "./index.ts";
import { listModels, type ModelInfo } from "./models.ts";
import type { Provider } from "./types.ts";

export interface ProviderFactory {
  /** Recorded with sessions and trajectories: "openrouter", "ollama", or "custom". */
  id: string;
  model: string;
  /** Runs on this machine (Ollama): no cost. */
  local?: boolean;
  /** The session's provider; `model` for a subagent type that names another one; `info` once the model list was read. */
  make(model?: string, info?: Pick<ModelInfo, "reasoning">): Provider;
  /** What the provider's model list says about the model (context window, prices, reasoning), when it has a list. */
  lookup?(): Promise<ModelInfo | undefined>;
}

/** What the SDK takes: a built-in provider by name, or any Provider of your own. */
export type ProviderOption =
  | { kind: "openrouter"; apiKey: string; model?: string; baseUrl?: string }
  | { kind: "ollama"; model: string; host?: string; contextLength?: number }
  | Provider;

export const isFactory = (value: ProviderFactory | ProviderOption): value is ProviderFactory =>
  typeof (value as ProviderFactory).make === "function";

/** The TUI's way: from its resolved Config, with the provider maker and model list it was given (tests swap both). */
export function configFactory(
  config: Config,
  make: (config: Config, info?: Pick<ModelInfo, "reasoning">) => Provider = createProvider,
  load: (config: Pick<Config, "provider" | "baseUrl">) => Promise<ModelInfo[]> = listModels,
): ProviderFactory {
  return {
    id: config.provider,
    model: config.model,
    local: config.provider === "ollama",
    make: (model, info) => make(model ? { ...config, model } : config, info),
    // OpenRouter's list has every model's context window, prices and reasoning; Ollama's knows none of that.
    lookup: config.provider === "openrouter" ? () => load(config).then((models) => models.find((m) => m.id === config.model)) : undefined,
  };
}

/** The SDK's way. Environment variables (OPENROUTER_API_KEY, MARV_MODEL…) are ignored: a library uses what it's given. */
export function providerFactory(option: ProviderOption, thinking = false): ProviderFactory {
  if ("stream" in option) return { id: "custom", model: option.name, make: () => option };
  const file =
    option.kind === "openrouter"
      ? { provider: "openrouter" as const, apiKey: option.apiKey, model: option.model, baseUrl: option.baseUrl }
      : { provider: "ollama" as const, model: option.model, contextLength: option.contextLength };
  const env = option.kind === "ollama" && option.host ? { OLLAMA_HOST: option.host } : {};
  return configFactory({ ...resolveConfig(file, env), thinking });
}
