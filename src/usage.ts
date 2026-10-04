// Token and cost accounting for a session.
//
// OpenRouter reports what each request actually cost (`usage.cost`, which
// accounts for cache discounts and which provider served it). When a cost
// isn't reported, it's estimated from the model's prices; local models are free.
import type { Usage } from "./provider/types.ts";

export interface Totals {
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  /** USD; undefined when neither reported nor estimable. */
  cost?: number;
  /** Some of the cost was estimated from prices rather than reported. */
  estimated?: boolean;
  /** A local model (Ollama): no cost. */
  local?: boolean;
}

/** $ per million tokens. */
export interface Prices {
  priceIn?: number;
  priceOut?: number;
  priceCacheRead?: number;
}

export const emptyTotals = (): Totals => ({ requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 });

export function estimateCost({ promptTokens, completionTokens, cachedTokens = 0 }: Usage, { priceIn, priceOut, priceCacheRead }: Prices): number | undefined {
  if (priceIn === undefined || priceOut === undefined) return undefined;
  const cacheRate = priceCacheRead ?? priceIn;
  return ((promptTokens - cachedTokens) * priceIn + cachedTokens * cacheRate + completionTokens * priceOut) / 1_000_000;
}

export function addUsage(totals: Totals, usage: Usage, prices: Prices = {}): Totals {
  const reported = usage.cost;
  const cost = reported ?? estimateCost(usage, prices);
  return {
    ...totals,
    requests: totals.requests + 1,
    promptTokens: totals.promptTokens + usage.promptTokens,
    cachedTokens: totals.cachedTokens + (usage.cachedTokens ?? 0),
    completionTokens: totals.completionTokens + usage.completionTokens,
    cost: cost === undefined ? totals.cost : (totals.cost ?? 0) + cost,
    estimated: totals.estimated || (reported === undefined && cost !== undefined),
  };
}

export const tokens = (n: number) =>
  n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${+(n / 1_000_000).toFixed(1)}M`;

/** "$0.042", "~$0.042" (estimated), "<$0.001", "local", or "" before any request. */
export function costText({ requests, cost, estimated, local }: Totals): string {
  if (requests === 0) return "";
  if (local) return "local";
  if (cost === undefined) return "";
  const amount = cost === 0 ? "$0.00" : cost < 0.001 ? "<$0.001" : cost < 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
  return estimated && cost >= 0.001 ? `~${amount}` : amount;
}

/** /cost: the session so far, and how full the context is. */
export function usageReport(totals: Totals, last: Usage | null, contextLength?: number): string {
  if (totals.requests === 0) return "No requests yet this session.";
  const cachedShare = totals.promptTokens ? Math.round((100 * totals.cachedTokens) / totals.promptTokens) : 0;
  const cost = totals.local
    ? "Cost: none (a local model)"
    : totals.cost === undefined
      ? "Cost: unknown (the provider didn't report one and the model's prices aren't known)"
      : `Cost: ${costText(totals)}${totals.estimated ? " (partly estimated from the model's prices)" : ""}`;
  const lines = [
    `This session: ${totals.requests} request${totals.requests === 1 ? "" : "s"}`,
    `  ${tokens(totals.promptTokens)} input tokens (${tokens(totals.cachedTokens)} from the cache, ${cachedShare}%)`,
    `  ${tokens(totals.completionTokens)} output tokens`,
    cost,
  ];
  if (last) {
    const used = last.promptTokens + last.completionTokens;
    lines.push(`Context: ${tokens(used)}${contextLength ? ` of ${tokens(contextLength)} tokens (${Math.round((100 * used) / contextLength)}%)` : " tokens"}`);
  }
  return lines.join("\n");
}
