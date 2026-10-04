import { describe, expect, test } from "bun:test";
import { addUsage, costText, emptyTotals, estimateCost, usageReport } from "../src/usage.ts";

describe("usage totals", () => {
  test("add up across requests, preferring the provider's reported cost", () => {
    let totals = emptyTotals();
    totals = addUsage(totals, { promptTokens: 1000, completionTokens: 100, cachedTokens: 800, cost: 0.002 });
    totals = addUsage(totals, { promptTokens: 1200, completionTokens: 50, cachedTokens: 1000, cost: 0.001 });
    expect(totals).toMatchObject({ requests: 2, promptTokens: 2200, completionTokens: 150, cachedTokens: 1800 });
    expect(totals.cost).toBeCloseTo(0.003);
    expect(totals.estimated).toBe(false);
  });

  test("estimate from the model's prices when the provider doesn't report a cost", () => {
    const prices = { priceIn: 2, priceOut: 10, priceCacheRead: 0.2 }; // $ per million tokens
    // 200 uncached input at $2/M + 800 cached at $0.2/M + 100 output at $10/M
    expect(estimateCost({ promptTokens: 1000, completionTokens: 100, cachedTokens: 800 }, prices)).toBeCloseTo(0.0004 + 0.00016 + 0.001);
    const totals = addUsage(emptyTotals(), { promptTokens: 1000, completionTokens: 100, cachedTokens: 800 }, prices);
    expect(totals.estimated).toBe(true);
  });

  test("without a cost or prices, the cost stays unknown", () => {
    const totals = addUsage(emptyTotals(), { promptTokens: 1000, completionTokens: 100 });
    expect(totals.cost).toBeUndefined();
  });
});

describe("costText", () => {
  test.each([
    [0.0423, "$0.042"],
    [1.5, "$1.50"],
    [0.0004, "<$0.001"],
    [0, "$0.00"],
  ])("%d -> %s", (cost, text) => {
    expect(costText({ ...emptyTotals(), requests: 1, cost })).toBe(text);
  });

  test("local models and estimates are labeled", () => {
    expect(costText({ ...emptyTotals(), requests: 1, cost: 0, local: true })).toBe("local");
    expect(costText({ ...emptyTotals(), requests: 1, cost: 0.0423, estimated: true })).toBe("~$0.042");
    expect(costText(emptyTotals())).toBe("");
  });
});

test("usageReport breaks the session down for /cost", () => {
  const totals = { ...emptyTotals(), requests: 3, promptTokens: 24_000, cachedTokens: 18_000, completionTokens: 1200, cost: 0.0312 };
  const report = usageReport(totals, { promptTokens: 9000, completionTokens: 400 }, 1_000_000);
  expect(report).toContain("3 requests");
  expect(report).toContain("24k input tokens (18k from the cache, 75%)");
  expect(report).toContain("1.2k output tokens");
  expect(report).toContain("$0.031");
  expect(report).toContain("9.4k of 1M tokens");
});
