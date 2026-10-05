import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as sdk from "marv/sdk";
import { createSession, type SessionEvent, type Tool } from "marv/sdk";
import type { AgentEvent } from "../src/provider/types.ts";
import { ScriptedProvider } from "./fake-provider.ts";

let root: string;
let configDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-sdk-project-"));
  configDir = await mkdtemp(join(tmpdir(), "marv-sdk-config-"));
  await writeFile(join(root, "AGENTS.md"), "Always answer in French.");
  await mkdir(join(root, ".marv", "skills", "release-notes"), { recursive: true });
  await writeFile(join(root, ".marv", "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\ndescription: Write release notes from git log\n---\nRun git log.");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

const say = (text: string): AgentEvent[] => [
  { type: "text_delta", text },
  { type: "done", reason: "stop" },
];
async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("the package entry exports what the README promises", () => {
  for (const name of ["createSession", "ToolError", "OllamaProvider", "OpenAICompatProvider", "SessionStore", "TrajectoryStore"]) {
    expect(sdk).toHaveProperty(name);
  }
});

test("by default nothing is read from disk", async () => {
  const provider = new ScriptedProvider([say("Hello.")]);
  const session = await createSession({ cwd: root, provider, configDir });
  await collect(session.send("hi"));
  const { system, tools } = provider.requests[0]!.options;
  expect(system).not.toContain("Always answer in French.");
  expect(tools!.map((t) => t.name)).not.toContain("skill");
  await session.close();
});

test("sources: ['project'] reads the repository's AGENTS.md and skills", async () => {
  const provider = new ScriptedProvider([say("Bonjour.")]);
  const session = await createSession({ cwd: root, provider, configDir, sources: ["project"] });
  await collect(session.send("hi"));
  const { system, tools } = provider.requests[0]!.options;
  expect(system).toContain("Always answer in French.");
  expect(system).toContain("release-notes");
  expect(tools!.map((t) => t.name)).toContain("skill");
  await session.close();
});

test("a tool of your own is offered and runs (the README example)", async () => {
  const clock: Tool = {
    name: "clock",
    description: "The current time.",
    input: z.object({}),
    label: () => "now",
    run: async () => ({ output: "12:00", summary: "12:00" }),
  };
  const provider = new ScriptedProvider([
    [{ type: "tool_call", call: { id: "c1", name: "clock", arguments: "{}" } }, { type: "done", reason: "tool_calls" }],
    say("It's noon."),
  ]);
  const session = await createSession({ cwd: root, provider, configDir, tools: [clock] });
  const events = await collect(session.send("what time is it?"));
  expect(provider.requests[0]!.options.tools!.map((t) => t.name)).toContain("clock");
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_end", result: expect.objectContaining({ output: "12:00" }) }));
  expect(events.at(-1)).toMatchObject({ type: "turn_end", reason: "end" });
  await session.close();
});

test("persist: true saves where marv -r finds it, and resume picks it up", async () => {
  const first = await createSession({ cwd: root, provider: new ScriptedProvider([say("Noted.")]), configDir, persist: true });
  await collect(first.send("remember 42"));
  await first.close();
  const provider = new ScriptedProvider([say("42.")]);
  const second = await createSession({ cwd: root, provider, configDir, persist: true, resume: "latest" });
  expect(second.id).toBe(first.id);
  await collect(second.send("what was it?"));
  expect(provider.requests[0]!.history.map((t) => t.text)).toEqual(["remember 42", "Noted.", "what was it?"]);
  await second.close();
});

test("resuming an id that doesn't exist fails", async () => {
  await expect(createSession({ cwd: root, provider: new ScriptedProvider([]), configDir, persist: true, resume: "nope" })).rejects.toThrow(/no saved session/);
});

test("a bad MCP server entry is reported in problems, not thrown", async () => {
  const session = await createSession({ cwd: root, provider: new ScriptedProvider([]), configDir, mcpServers: { bad__name: { command: "x" } } });
  expect(session.problems.join("\n")).toContain("bad__name");
  await session.close();
});

test("${MARV_PROJECT_DIR} in a server given in code expands to the project", async () => {
  // An unset variable without a default is a problem, so no problem means it was expanded.
  const session = await createSession({ cwd: root, provider: new ScriptedProvider([]), configDir, mcpServers: { fs: { command: "true", args: ["${MARV_PROJECT_DIR}"] } } });
  expect(session.problems).toEqual([]);
  await session.close();
});
