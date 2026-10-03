// Which models a provider offers, for the model picker in /setup and /model.
import type { Config } from "../config/config.ts";

export interface ModelInfo {
  id: string;
  /** Can call tools (needed from milestone 4 on). Undefined = unknown. */
  tools?: boolean;
  /** USD per million tokens. */
  priceIn?: number;
  priceOut?: number;
  context?: number;
  /** Runs on this machine (Ollama). */
  local?: boolean;
}

interface OpenRouterModel {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

export async function listModels(
  config: Pick<Config, "provider" | "baseUrl">,
  fetchFn: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  switch (config.provider) {
    case "openrouter": {
      // Public endpoint, no key needed. Prices come back in USD per token.
      const { data } = await getJson<{ data: OpenRouterModel[] }>(fetchFn, `${config.baseUrl}/models`);
      return data
        // Only models that can call tools; ":batch" variants are for offline bulk jobs, not chat.
        .filter((m) => m.supported_parameters?.includes("tools") && !m.id.endsWith(":batch"))
        .map((m) => ({
          id: m.id,
          tools: true,
          priceIn: perMillion(m.pricing?.prompt),
          priceOut: perMillion(m.pricing?.completion),
          context: m.context_length,
        }));
    }

    case "ollama": {
      // Ollama's native API (not the /v1 compatibility layer) lists local
      // models and, per model, its capabilities.
      const origin = new URL(config.baseUrl).origin;
      const { models } = await getJson<{ models: { name: string }[] }>(fetchFn, `${origin}/api/tags`);
      return Promise.all(
        models.map(async ({ name }) => {
          const info = await getJson<{ capabilities?: string[] }>(fetchFn, `${origin}/api/show`, { model: name }).catch(
            () => ({ capabilities: undefined }),
          );
          return { id: name, tools: info.capabilities?.includes("tools"), local: true };
        }),
      );
    }
  }
}

async function getJson<T>(fetchFn: typeof fetch, url: string, body?: unknown): Promise<T> {
  const response = await fetchFn(url, body ? { method: "POST", body: JSON.stringify(body) } : undefined);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return (await response.json()) as T;
}

function perMillion(perToken: string | undefined): number | undefined {
  const n = Number(perToken);
  return perToken === undefined || Number.isNaN(n) ? undefined : Math.round(n * 1e6 * 1e6) / 1e6;
}

/** "$2 / $10" (in / out per million tokens), "free", or "local". */
export function formatPrice(model: ModelInfo): string {
  if (model.local) return "local";
  if (model.priceIn === undefined || model.priceOut === undefined) return "";
  if (model.priceIn === 0 && model.priceOut === 0) return "free";
  const usd = (n: number) => `$${Number(n.toPrecision(n < 1 ? 2 : 3))}`;
  return `${usd(model.priceIn)} / ${usd(model.priceOut)}`;
}
