// The whole path with the real TypeScript compiler, in the real sandbox: Marv's own TypeScript, copied into a temp
// project the way the evals do it (evals/typescript.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTypeScript } from "../evals/typescript.ts";
import type { AgentEvent, ToolCall } from "../src/provider/types.ts";
import { sandboxAvailable } from "../src/sandbox.ts";
import { MarvSession, type SessionEvent } from "../src/session.ts";
import { ScriptedProvider } from "./fake-provider.ts";

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ESNext", module: "Preserve", moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true, types: [] },
  include: ["src"],
});
const say = (text: string): AgentEvent[] => [{ type: "text_delta", text }, { type: "done", reason: "stop" }];
const write = (path: string, content: string): AgentEvent[] => [
  { type: "tool_call", call: { id: `w-${path}`, name: "write_file", arguments: JSON.stringify({ path, content }) } satisfies ToolCall },
  { type: "done", reason: "tool_calls" },
];

describe.if(sandboxAvailable())("the typecheck after a change, with the real tsc in the sandbox", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marv-tsc-e2e-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(root, "src", "format.ts"), "export function formatPrice(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n");
    writeFileSync(join(root, "src", "cart.ts"), 'import { formatPrice } from "./format.ts";\n\nexport const total = (cents: number) => formatPrice(cents);\n');
    addTypeScript(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function turn(...steps: AgentEvent[][]) {
    const provider = new ScriptedProvider([...steps, say("Done.")]);
    const session = new MarvSession({ root, provider: { id: "test", model: "test", make: () => provider } });
    const events: SessionEvent[] = [];
    for await (const event of session.send("go")) events.push(event);
    await session.close();
    return { provider, events };
  }

  test("renaming an export: the model is told about the caller it broke, in a file it didn't touch", async () => {
    const { provider } = await turn(write("src/format.ts", "export function formatMoney(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n"));
    const note = provider.requests[1]!.history.at(-1);
    expect(note?.role).toBe("user");
    expect(note?.text).toStartWith("Marv: the typecheck (tsc) after your changes found");
    expect(note?.text).toContain("src/cart.ts:1:");
    expect(note?.text).toContain("formatPrice");
  }, 30_000);

  test("a change that breaks nothing adds nothing", async () => {
    const { provider } = await turn(write("src/extra.ts", "export const extra = 1;\n"));
    expect(provider.requests[1]!.history.at(-1)?.role).toBe("tool");
  }, 30_000);

  test("errors that were already there aren't blamed on the model", async () => {
    writeFileSync(join(root, "src", "old.ts"), "export const broken: number = 'not a number';\n");
    const { provider, events } = await turn(write("src/extra.ts", "export const extra = 1;\n"));
    expect(provider.requests[1]!.history.at(-1)?.role).toBe("tool");
    expect(events).toContainEqual({ type: "check", result: expect.objectContaining({ status: "done", errors: 1, added: [] }) });
  }, 30_000);
});
