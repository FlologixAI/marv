import { describe, expect, test } from "bun:test";
import { compactedHistory, summarize } from "../src/compact.ts";
import type { AgentEvent, ChatTurn } from "../src/provider/types.ts";
import { ScriptedProvider } from "./fake-provider.ts";

const HISTORY: ChatTurn[] = [
  { role: "user", text: "make the scroll smoother" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"src/ui/ScrollView.tsx"}' }] },
  { role: "tool", callId: "c1", name: "read_file", text: "…file contents…" },
  { role: "assistant", text: "Done: it glides now." },
];
const say = (text: string): AgentEvent[] => [{ type: "text_delta", text }, { type: "done" }];

describe("summarize", () => {
  test("asks for a summary on top of the same prefix (system, tools, history), so the cache still hits", async () => {
    const model = new ScriptedProvider([say("Summary: scroll glide added in src/ui/ScrollView.tsx.")]);
    const tools = [{ name: "read_file", description: "d", parameters: {} }];
    const result = await summarize({ provider: model, history: HISTORY, system: "SYSTEM", tools, signal: new AbortController().signal });

    expect(result).toEqual({ summary: "Summary: scroll glide added in src/ui/ScrollView.tsx." });
    const request = model.requests[0]!;
    expect(request.options.system).toBe("SYSTEM");
    expect(request.options.tools).toBe(tools);
    expect(request.history.slice(0, HISTORY.length)).toEqual(HISTORY);
    expect(request.history.at(-1)).toMatchObject({ role: "user", text: expect.stringContaining("Summarize") });
  });

  test("passes along what to focus on", async () => {
    const model = new ScriptedProvider([say("ok")]);
    await summarize({ provider: model, history: HISTORY, system: "S", tools: [], signal: new AbortController().signal, focus: "the sandbox" });
    expect((model.requests[0]!.history.at(-1) as { text: string }).text).toContain("Focus especially on: the sandbox");
  });

  test("reports errors and empty summaries instead of compacting", async () => {
    const failing = new ScriptedProvider([[{ type: "error", message: "Rate limited" }]]);
    expect(await summarize({ provider: failing, history: HISTORY, system: "S", tools: [], signal: new AbortController().signal })).toEqual({ error: "Rate limited" });
    const empty = new ScriptedProvider([say("   ")]);
    expect(await summarize({ provider: empty, history: HISTORY, system: "S", tools: [], signal: new AbortController().signal })).toMatchObject({ error: expect.any(String) });
  });
});

test("compactedHistory starts the model's history over from the summary", () => {
  expect(compactedHistory("the summary")).toEqual([
    { role: "user", text: expect.stringContaining("the summary") },
    { role: "assistant", text: expect.any(String) },
  ]);
});
