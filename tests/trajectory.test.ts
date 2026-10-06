import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { projectKey } from "../src/paths.ts";
import { AgentRecorder, TrajectoryStore, type TrajectoryRecord } from "../src/trajectory.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marv-traj-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async (path: string) =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("the trajectory file", () => {
  test("one JSON record per line, in order, stamped with the session; private", async () => {
    const log = new TrajectoryStore(dir).open("/home/me/proj", "s1");
    for (let i = 0; i < 20; i++) log.write({ type: "feedback", turn: "t1", score: 1, source: "explicit" });
    log.write({ type: "turn_start", turn: "t2", text: "hi", model: "m", provider: "ollama" });
    await log.flush();
    expect(log.path).toBe(join(dir, projectKey("/home/me/proj"), "s1.jsonl"));
    const records = await lines(log.path);
    expect(records).toHaveLength(21);
    expect(records.at(-1)).toMatchObject({ v: 1, session: "s1", type: "turn_start", turn: "t2", text: "hi" });
    expect(typeof records[0]!.t).toBe("string");
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
  });

  test("a resumed session keeps appending to the same file", async () => {
    const store = new TrajectoryStore(dir);
    const first = store.open("/p", "s1");
    first.write({ type: "feedback", turn: "a", score: 1, source: "explicit" });
    await first.flush();
    const again = store.open("/p", "s1");
    again.write({ type: "feedback", turn: "b", score: -1, source: "explicit" });
    await again.flush();
    expect((await lines(again.path)).map((r) => r.turn)).toEqual(["a", "b"]);
  });

  test("a half-written last line (a crash) isn't glued to the next record", async () => {
    const store = new TrajectoryStore(dir);
    const log = store.open("/p", "s1");
    await mkdir(dirname(log.path), { recursive: true });
    await writeFile(log.path, '{"v":1,"type":"turn_start","turn":"a"}\n{"v":1,"type":"agent_end","tur');
    log.write({ type: "feedback", turn: "b", score: 1, source: "explicit" });
    await log.flush();
    const lines = (await readFile(log.path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!)).toMatchObject({ type: "feedback", turn: "b" });
  });

  test("a failing write never throws into the agent; it's reported once", async () => {
    const errors: string[] = [];
    const log = new TrajectoryStore(join(dir, "\0bad")).open("/p", "s1");
    log.onError = (message) => errors.push(message);
    log.write({ type: "feedback", turn: "a", score: 1, source: "explicit" });
    log.write({ type: "feedback", turn: "b", score: 1, source: "explicit" });
    await log.flush();
    expect(errors).toHaveLength(1);
  });
});

describe("recording one agent's run", () => {
  function recorder(agent = "main") {
    const records: TrajectoryRecord[] = [];
    let now = 1000;
    const rec = new AgentRecorder((r) => records.push(r), { turn: "t1", agent }, () => now);
    return { rec, records, advance: (ms: number) => (now += ms) };
  }
  const call = { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' };

  test("requests with their tokens and latency, replies with their reasoning, tool calls with what the model saw", () => {
    const { rec, records, advance } = recorder();
    rec.event({ type: "thinking_delta", text: "Let me look." });
    advance(800);
    rec.event({ type: "usage", usage: { promptTokens: 100, completionTokens: 20 } });
    rec.event({ type: "assistant", text: "Reading a.ts." });
    rec.event({ type: "tool_start", call, label: "a.ts" });
    advance(5);
    rec.event({ type: "tool_end", call, result: { output: "1\tx", summary: "1 line", label: "a.ts", approval: "auto" } });
    advance(300);
    rec.event({ type: "usage", usage: { promptTokens: 130, completionTokens: 8, cost: 0.001 } });
    rec.event({ type: "assistant", text: "It has x." });
    rec.event({ type: "done", reason: "end" });

    expect(records).toEqual([
      { type: "request", turn: "t1", agent: "main", step: 1, usage: { promptTokens: 100, completionTokens: 20 }, ms: 800 },
      { type: "assistant", turn: "t1", agent: "main", text: "Reading a.ts.", thinking: "Let me look." },
      {
        type: "tool",
        turn: "t1",
        agent: "main",
        call,
        output: "1\tx",
        summary: "1 line",
        isError: false,
        declined: false,
        approval: "auto",
        ms: 5,
      },
      { type: "request", turn: "t1", agent: "main", step: 2, usage: { promptTokens: 130, completionTokens: 8, cost: 0.001 }, ms: 300 },
      { type: "assistant", turn: "t1", agent: "main", text: "It has x." },
      { type: "agent_end", turn: "t1", agent: "main", reason: "end", steps: 2, tools: 1, ms: 1105 },
    ]);
  });

  test("reasoning before a tool call with no text is kept too", () => {
    const { rec, records } = recorder("sub-1");
    rec.event({ type: "thinking_delta", text: "Need the file." });
    rec.event({ type: "tool_start", call, label: "a.ts" });
    expect(records).toEqual([{ type: "assistant", turn: "t1", agent: "sub-1", text: "", thinking: "Need the file." }]);
  });

  test("a read-only call needed no approval; errors are recorded", () => {
    const { rec, records } = recorder();
    rec.event({ type: "tool_start", call, label: "a.ts" });
    rec.event({ type: "tool_end", call, result: { output: "File not found", summary: "error", isError: true, label: "a.ts" } });
    rec.event({ type: "error", message: "Rate limited" });
    expect(records[0]).toMatchObject({ type: "tool", isError: true, approval: "none" });
    expect(records[1]).toEqual({ type: "error", turn: "t1", agent: "main", message: "Rate limited" });
  });

  test("a call answered without running is recorded with what the model got", () => {
    const { rec, records } = recorder();
    rec.event({ type: "tool_skipped", call, output: "Not run: the user declined an earlier action." });
    expect(records).toEqual([
      { type: "tool", turn: "t1", agent: "main", call, output: "Not run: the user declined an earlier action.", summary: "not run", isError: false, declined: true, approval: "none", ms: 0 },
    ]);
  });

  test("hitting the step limit is recorded, with the user's answer", () => {
    const { rec, records } = recorder();
    rec.event({ type: "step_limit", steps: 25, continued: true });
    expect(records).toEqual([{ type: "step_limit", turn: "t1", agent: "main", steps: 25, continued: true }]);
  });

  test("a reply cut off at the output limit is recorded (the model was told, so its next step makes sense)", () => {
    const { rec, records } = recorder();
    rec.event({ type: "cut_off", continued: true });
    expect(records).toEqual([{ type: "cut_off", turn: "t1", agent: "main", continued: true }]);
  });

  test("finish() closes a run that never sent done (it threw), once", () => {
    const { rec, records } = recorder();
    rec.finish("error");
    rec.event({ type: "done", reason: "end" });
    rec.finish("error");
    expect(records).toEqual([{ type: "agent_end", turn: "t1", agent: "main", reason: "error", steps: 0, tools: 0, ms: 0 }]);
  });
});
