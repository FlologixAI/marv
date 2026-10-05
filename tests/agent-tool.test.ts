import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";
import { GENERAL_PURPOSE, type AgentType } from "../src/agents.ts";
import type { AgentEvent, ChatTurn, Provider, StreamOptions, ToolCall, Usage } from "../src/provider/types.ts";
import { sandboxAvailable } from "../src/sandbox.ts";
import { isParallelCall, runTool } from "../src/tools/index.ts";
import type { AgentHost, AgentProgress, ApprovalRequest, Decision, ToolContext } from "../src/tools/types.ts";
import { NOT_A_REPO } from "../src/worktree.ts";
import { RoutedProvider, ScriptedProvider } from "./fake-provider.ts";

let root: string;
let trees: string;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-agent-tool-"));
  trees = await mkdtemp(join(tmpdir(), "marv-agent-trees-"));
  await writeFile(join(root, "notes.txt"), "remember the milk\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(trees, { recursive: true, force: true });
});

const say = (text: string, usage?: Usage): AgentEvent[] => [
  { type: "text_delta", text },
  ...(usage ? [{ type: "usage" as const, usage }] : []),
  { type: "done", reason: "stop" },
];
const useTool = (id: string, name: string, args: unknown): AgentEvent[] => [
  { type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } },
  { type: "done", reason: "tool_calls" },
];
const agentCall = (args: Record<string, unknown>, id = "a1"): ToolCall => ({ id, name: "agent", arguments: JSON.stringify(args) });

function makeHost(provider: Provider, over: Partial<AgentHost> = {}) {
  const seen = { usage: [] as Usage[], progress: [] as AgentProgress[], models: [] as (string | undefined)[] };
  const host: AgentHost = {
    agents: [GENERAL_PURPOSE],
    providerFor: (model) => (seen.models.push(model), provider),
    cwd: "~/proj",
    worktreesDir: trees,
    onUsage: (u) => seen.usage.push(u),
    onProgress: (_id, p) => seen.progress.push(p),
    ...over,
  };
  return { host, seen };
}

function ctxWith(host: AgentHost, decide: (r: ApprovalRequest) => Decision = () => "yes") {
  const asked: ApprovalRequest[] = [];
  const ctx: ToolContext = { root, agentHost: host, approve: async (r) => (asked.push(r), decide(r)) };
  return { ctx, asked };
}

describe("the agent tool", () => {
  test("the subagent starts fresh, and only its last message comes back", async () => {
    const provider = new ScriptedProvider([say("Found 3 callers.", { promptTokens: 1000, completionTokens: 200 })]);
    const { host, seen } = makeHost(provider);
    const { ctx, asked } = ctxWith(host);
    const result = await runTool(agentCall({ description: "find callers", prompt: "Find callers of foo" }), ctx);

    expect(provider.requests[0]!.history).toEqual([{ role: "user", text: "Find callers of foo" }]);
    expect(result.output).toBe("Found 3 callers.");
    expect(result.summary).toBe('done · 0 tools · 1.2k tokens · "Found 3 callers."');
    expect(result.label).toBe("general-purpose · find callers");
    expect(asked).toHaveLength(0); // a shared-folder dispatch doesn't ask
    expect(seen.usage).toEqual([{ promptTokens: 1000, completionTokens: 200 }]);
  });

  test("it gets subagent tools only, and its type's instructions", async () => {
    const reviewer: AgentType = { ...GENERAL_PURPOSE, name: "reviewer", body: "You review code.", tools: ["read_file", "grep"], source: "project" };
    const provider = new ScriptedProvider([say("ok"), say("ok")]);
    const { host } = makeHost(provider, { agents: [GENERAL_PURPOSE, reviewer] });
    const { ctx } = ctxWith(host);
    await runTool(agentCall({ description: "x", prompt: "p" }), ctx);
    await runTool(agentCall({ type: "superpowers:reviewer", description: "x", prompt: "p" }), ctx);

    expect(provider.requests[0]!.options.tools!.map((t) => t.name)).toEqual(["read_file", "glob", "grep", "edit_file", "write_file", "bash"]);
    expect(provider.requests[1]!.options.tools!.map((t) => t.name)).toEqual(["read_file", "grep"]);
    expect(provider.requests[1]!.options.system).toStartWith("You review code.");
  });

  test("a tool it wasn't given is refused, even if the model names it", async () => {
    const provider = new ScriptedProvider([useTool("m1", "memory", { action: "add", text: "x" }), say("ok")]);
    const { host } = makeHost(provider);
    await runTool(agentCall({ description: "x", prompt: "p" }), ctxWith(host).ctx);
    expect(provider.requests[1]!.history.at(-1)).toMatchObject({ role: "tool", text: expect.stringContaining('Unknown tool "memory"') });
  });

  test("it works in the project, and reports progress", async () => {
    const provider = new ScriptedProvider([useTool("r1", "read_file", { path: "notes.txt" }), say("It says milk.")]);
    const { host, seen } = makeHost(provider);
    const result = await runTool(agentCall({ description: "read notes", prompt: "What's in notes.txt?" }), ctxWith(host).ctx);
    expect(result.summary).toStartWith("done · 1 tool ·");
    expect(seen.progress.map((p) => p.line)).toContain("shared folder · 1 tool · read_file notes.txt");
    expect(seen.progress.at(-1)!.steps).toEqual(["read_file notes.txt · 1 line"]);
  });

  test("an error returns what it had, marked as an error", async () => {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "Partial findings." }, { type: "error", message: "Rate limited" }]]);
    const { host } = makeHost(provider);
    const result = await runTool(agentCall({ description: "x", prompt: "p" }), ctxWith(host).ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Partial findings.");
    expect(result.output).toContain("Rate limited");
    expect(result.summary).toStartWith("stopped ·");
  });

  test("a type's model gets its own provider", async () => {
    const fast: AgentType = { ...GENERAL_PURPOSE, name: "fast", model: "small-model", source: "project" };
    const { host, seen } = makeHost(new ScriptedProvider([say("ok")]), { agents: [GENERAL_PURPOSE, fast] });
    await runTool(agentCall({ type: "fast", description: "x", prompt: "p" }), ctxWith(host).ctx);
    expect(seen.models).toEqual(["small-model"]);
  });

  test("unknown types and nesting are errors the model can read", async () => {
    const { host } = makeHost(new ScriptedProvider([]));
    expect((await runTool(agentCall({ type: "nope", description: "x", prompt: "p" }), ctxWith(host).ctx)).output).toContain('no agent type "nope". Available: general-purpose');
    expect((await runTool(agentCall({ description: "x", prompt: "p" }), { root })).output).toContain("Subagents can't start subagents");
  });

  test("a shared-folder subagent's changes are approved by the user, labeled with who asks", async () => {
    const provider = new ScriptedProvider([useTool("w1", "write_file", { path: "made.txt", content: "hi\n" }), say("Made it.")]);
    const { host } = makeHost(provider);
    const { ctx, asked } = ctxWith(host);
    await runTool(agentCall({ description: "make file", prompt: "p" }), ctx);
    expect(asked.map((r) => [r.tool, r.agent])).toEqual([["write_file", "general-purpose · make file"]]);
    expect(existsSync(join(root, "made.txt"))).toBe(true);
  });

  test("a no inside the subagent stops it and the parent", async () => {
    const provider = new ScriptedProvider([useTool("w1", "write_file", { path: "made.txt", content: "hi\n" }), say("never")]);
    const { host } = makeHost(provider);
    const result = await runTool(agentCall({ description: "x", prompt: "p" }), ctxWith(host, () => "no").ctx);
    expect(result.declined).toBe(true);
    expect(provider.requests).toHaveLength(1);
  });

  describe("in a worktree", () => {
    beforeEach(() => {
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.email", "test@example.com");
      git(root, "config", "user.name", "Test");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "first");
    });

    test("approve once to start it; its edits land on its own branch", async () => {
      const provider = new ScriptedProvider([useTool("w1", "write_file", { path: "new.txt", content: "new\n" }), say("Added new.txt.")]);
      const { host } = makeHost(provider);
      const { ctx, asked } = ctxWith(host);
      const result = await runTool(agentCall({ description: "add file", prompt: "p", isolation: "worktree" }), ctx);

      // The dispatch is approved; inside the worktree, edits run without asking (when the sandbox works).
      expect(asked[0]!.tool).toBe("agent");
      expect(asked[0]!.scope.key).toBe("agent:worktree");
      expect(asked).toHaveLength(sandboxAvailable() ? 1 : 2);
      const branch = /Branch (marv\/add-file-[0-9a-f]{4}): 1 commit/.exec(result.output)?.[1];
      expect(branch).toBeDefined();
      expect(git(root, "show", `${branch}:new.txt`)).toBe("new");
      expect(existsSync(join(root, "new.txt"))).toBe(false);
      expect(provider.requests[0]!.options.system).toContain(`branch ${branch}`);
    });

    test("network commands still ask", async () => {
      const provider = new ScriptedProvider([useTool("b1", "bash", { command: "bun install", network: true }), say("never")]);
      const { host } = makeHost(provider);
      const { ctx, asked } = ctxWith(host, (r) => (r.tool === "agent" ? "yes" : "no"));
      const result = await runTool(agentCall({ description: "install", prompt: "p", isolation: "worktree" }), ctx);
      expect(asked.map((r) => [r.tool, r.network, r.agent])).toEqual([
        ["agent", undefined, undefined],
        ["bash", true, "general-purpose · install"],
      ]);
      expect(result.declined).toBe(true);
    });

    test("a provider that throws still finishes the worktree and reports its branch", async () => {
      const throwing: Provider = {
        name: "throwing",
        async *stream() {
          throw new Error("connection reset");
        },
      };
      const { host } = makeHost(throwing);
      const result = await runTool(agentCall({ description: "boom", prompt: "p", isolation: "worktree" }), ctxWith(host).ctx);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("connection reset");
      expect(result.output).toMatch(/No changes \(branch marv\/boom-[0-9a-f]{4} removed\)/);
      expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
    });

    test("the approval warns about uncommitted changes", async () => {
      await writeFile(join(root, "dirty.txt"), "x\n");
      const { host } = makeHost(new ScriptedProvider([say("ok")]));
      const { ctx, asked } = ctxWith(host);
      await runTool(agentCall({ description: "x", prompt: "p", isolation: "worktree" }), ctx);
      expect(asked[0]!.preview.warning).toContain("1 uncommitted change in the project won't be in the worktree");
    });
  });

  test("outside a git repo, a worktree dispatch fails before asking", async () => {
    const { host } = makeHost(new ScriptedProvider([]));
    const { ctx, asked } = ctxWith(host);
    const result = await runTool(agentCall({ description: "x", prompt: "p", isolation: "worktree" }), ctx);
    expect(result.output).toBe(NOT_A_REPO);
    expect(asked).toHaveLength(0);
  });

  test("two subagents in one reply run at the same time", async () => {
    let active = 0;
    let max = 0;
    const slow = (text: string): Provider => ({
      name: "slow",
      async *stream(_h: ChatTurn[], _o?: StreamOptions) {
        active++;
        max = Math.max(max, active);
        await Bun.sleep(40);
        active--;
        yield { type: "text_delta", text } as AgentEvent;
        yield { type: "done" } as AgentEvent;
      },
    });
    const parent = new ScriptedProvider([
      [
        { type: "tool_call", call: agentCall({ description: "a", prompt: "alpha task" }, "a1") },
        { type: "tool_call", call: agentCall({ description: "b", prompt: "beta task" }, "a2") },
        { type: "done" },
      ],
      say("Both reported."),
    ]);
    const provider = new RoutedProvider({ "start two": parent, "alpha task": slow("A done"), "beta task": slow("B done") });
    const { host } = makeHost(provider);
    const history: ChatTurn[] = [{ role: "user", text: "start two" }];
    for await (const _ of runAgent({
      provider,
      history,
      system: "S",
      tools: [],
      runTool: (c) => runTool(c, { root, agentHost: host }),
      signal: new AbortController().signal,
      isParallel: isParallelCall,
    }));
    expect(max).toBe(2);
    expect(history.filter((t) => t.role === "tool").map((t) => t.role === "tool" && t.text)).toEqual(["A done", "B done"]);
  });
});
