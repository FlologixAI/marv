import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app.tsx";
import { ConfigStore, type Config, type FileConfig } from "../src/config/config.ts";
import { mouse } from "../src/mouse.ts";
import type { AgentEvent, ChatTurn, Provider, StreamOptions } from "../src/provider/types.ts";
import { selection } from "../src/selection.ts";
import type { Skill } from "../src/skills.ts";
import type { ModelInfo } from "../src/provider/models.ts";
import { SessionStore } from "../src/sessions.ts";
import { FakeProvider, ScriptedProvider } from "./fake-provider.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

// Let React and the async provider stream settle.
const tick = (ms = 50) => Bun.sleep(ms);

async function type(stdin: { write: (data: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write(ENTER);
}

// Any saved provider + model will do; makeProvider swaps in a fake, so nothing hits the network.
const LOCAL: FileConfig = { provider: "ollama", model: "qwen3.5:9b" };

let dir: string;
let project: string;
let store: ConfigStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marv-app-"));
  store = new ConfigStore(dir);
  // The project the agent works in: its tools can read files here.
  project = await mkdtemp(join(tmpdir(), "marv-project-"));
  await writeFile(join(project, "notes.txt"), "remember the milk\n");
});
afterEach(async () => {
  cleanup();
  await rm(dir, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

function renderApp(
  initialFile: FileConfig | null,
  splashMs = 0,
  copy = async (_text: string) => "test",
  makeProvider: (config: Config) => Provider = () => new FakeProvider(),
  instructions?: string,
  skills: Skill[] = [],
  skillProblems: string[] = [],
) {
  return render(
    <App
      store={store}
      initialFile={initialFile}
      env={{}}
      version="9.9.9"
      cwd="~/x"
      root={project}
      instructions={instructions}
      skills={skills}
      skillProblems={skillProblems}
      splashMs={splashMs}
      makeProvider={makeProvider}
      copy={copy}
      loadModels={async () => [{ id: "qwen3.5:9b", local: true, tools: true }]}
    />,
  );
}

describe("App", () => {
  test("shows the splash, then the main view after a key press", async () => {
    const { lastFrame, stdin } = renderApp(LOCAL, 60_000);
    expect(lastFrame()).toContain("press any key");

    stdin.write("x");
    await tick();
    expect(lastFrame()).toContain("Welcome to Marv");
  });

  test("first run opens setup and saves the result", async () => {
    const { lastFrame, frames, stdin } = renderApp(null);
    await tick();
    expect(lastFrame()).toContain("Marv setup");

    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER); // Ollama
    await tick();
    stdin.write(ENTER); // the only model the fake list offers
    await tick();

    expect(await store.load()).toEqual(LOCAL);
    await tick(); // the "Saved" notice renders just after the file is written
    expect(frames.join("\n")).toContain("Saved to");
    expect(lastFrame()).toContain("Type a message");
  });

  test("streams a reply through the provider", async () => {
    const { frames, stdin } = renderApp(LOCAL);
    await type(stdin, "hello world");
    await tick(200);
    expect(frames.join("\n")).toContain("You said: hello world");
  });

  test("/help prints the command list", async () => {
    const { frames, stdin } = renderApp(LOCAL);
    await type(stdin, "/help");
    await tick();
    expect(frames.join("\n")).toContain("Clear the conversation");
  });

  test("/config shows the provider and model", async () => {
    const { frames, stdin } = renderApp(LOCAL);
    await type(stdin, "/config");
    await tick();
    const output = frames.join("\n");
    expect(output).toContain("Provider:  Ollama");
    expect(output).toContain("API key:   not needed");
  });

  test("dragging over text copies it and says so", async () => {
    const copied: string[] = [];
    const { lastFrame } = renderApp(LOCAL, 0, async (text) => {
      copied.push(text);
      return "wl-copy";
    });
    await tick();
    // The real app feeds frames to the store through Ink's transformOutput hook.
    selection.transformOutput(lastFrame()!);
    const y = lastFrame()!.split("\n").findIndex((line) => line.includes("Welcome"));
    const x = lastFrame()!.split("\n")[y]!.indexOf("Welcome");

    mouse.emit("event", { type: "press", x, y });
    mouse.emit("event", { type: "drag", x: x + 6, y });
    mouse.emit("event", { type: "release", x: x + 6, y });
    await tick();

    expect(copied).toEqual(["Welcome"]);
    expect(lastFrame()).toContain("Copied 7 chars");
    selection.clear();
  });

  test("sends the system prompt and the conversation to the provider", async () => {
    const calls: { history: ChatTurn[]; options?: StreamOptions }[] = [];
    const spy: Provider = {
      name: "spy",
      async *stream(history, options) {
        calls.push({ history: [...history], options });
        yield { type: "text_delta", text: "ok" };
        yield { type: "done" };
      },
    };
    const { stdin } = renderApp(LOCAL, 0, undefined, () => spy);
    await type(stdin, "first");
    await tick(100);
    await type(stdin, "second");
    await tick(100);

    expect(calls[0]!.options?.system).toContain("You are Marv");
    expect(calls[0]!.options?.system).toContain("~/x");
    // Stateless API: the second request carries the whole conversation so far.
    expect(calls[1]!.history).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "ok" },
      { role: "user", text: "second" },
    ]);
  });

  test("/model <id> switches model and saves it", async () => {
    const ollama: FileConfig = { provider: "ollama", model: "gemma4:12b" };
    const { lastFrame, stdin } = renderApp(ollama);
    await type(stdin, "/model qwen3.5:9b");
    await tick(100);
    expect(await store.load()).toEqual({ provider: "ollama", model: "qwen3.5:9b" });
    expect(lastFrame()).toContain("Ollama · qwen3.5:9b");
  });

  test("/model opens the picker for the current provider", async () => {
    const { lastFrame, stdin } = renderApp({ provider: "ollama", model: "gemma4:12b" });
    await type(stdin, "/model");
    await tick(100);
    expect(lastFrame()).toContain("Switch Ollama model");
    expect(lastFrame()).toContain("qwen3.5:9b");
  });

  test("shows thinking while the model reasons, then keeps only a short note", async () => {
    const calls: ChatTurn[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const thinker: Provider = {
      name: "thinker",
      async *stream(history) {
        calls.push([...history]);
        yield { type: "thinking_delta", text: "Step 1: read the question.\nStep 2: answer briefly." };
        await gate;
        yield { type: "text_delta", text: "Hi!" };
        yield { type: "done" };
      },
    };
    const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => thinker);
    await type(stdin, "hello");
    await tick(100);
    expect(lastFrame()).toContain("Thinking… (9 words)");
    expect(lastFrame()).toContain("Step 2: answer briefly.");

    release();
    await tick(100);
    expect(lastFrame()).toContain("✻ Thought for");
    expect(lastFrame()).toContain("Hi!");
    expect(lastFrame()).not.toContain("Step 2");

    // The reasoning is never sent back: the next request has only the reply.
    await type(stdin, "again");
    await tick(100);
    expect(calls[1]).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "Hi!" },
      { role: "user", text: "again" },
    ]);
  });

  test("/think toggles thinking and saves it", async () => {
    const { lastFrame, stdin } = renderApp({ provider: "ollama", model: "qwen3.5:9b" });
    await type(stdin, "/think");
    await tick(100);
    expect(await store.load()).toEqual({ provider: "ollama", model: "qwen3.5:9b", thinking: true });
    expect(lastFrame()).toContain("Thinking on");
  });

  test("runs the tools the model asks for and shows them in the transcript", async () => {
    const model = new ScriptedProvider([
      [{ type: "tool_call", call: { id: "c1", name: "read_file", arguments: '{"path":"notes.txt"}' } }, { type: "done" }],
      [{ type: "text_delta", text: "It says to remember the milk." }, { type: "done" }],
    ]);
    const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
    await type(stdin, "what's in my notes?");
    await tick(200);

    const frame = lastFrame()!;
    expect(frame).toContain("● read_file notes.txt");
    expect(frame).toContain("⎿ 1 line");
    expect(frame).toContain("It says to remember the milk.");
    // The real tool ran on the project and its output went back to the model.
    expect(model.requests[1]!.history.at(-1)).toEqual({ role: "tool", callId: "c1", name: "read_file", text: "    1\tremember the milk" });
    expect(model.requests[0]!.options.tools!.map((t) => t.name)).toEqual(["read_file", "glob", "grep", "edit_file", "write_file", "bash"]);
  });

  test("a failing tool shows its error, and the model gets it to recover from", async () => {
    const model = new ScriptedProvider([
      [{ type: "tool_call", call: { id: "c1", name: "read_file", arguments: '{"path":"/etc/passwd"}' } }, { type: "done" }],
      [{ type: "text_delta", text: "I can't read that." }, { type: "done" }],
    ]);
    const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
    await type(stdin, "read /etc/passwd");
    await tick(200);
    expect(lastFrame()).toContain("is outside the project");
    expect(model.requests[1]!.history.at(-1)).toMatchObject({ role: "tool", text: expect.stringContaining("outside the project") });
  });

  test("shows token usage and cache hits in the status bar", async () => {
    const model = new ScriptedProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "usage", usage: { promptTokens: 1200, completionTokens: 30, cachedTokens: 1000 } },
        { type: "done" },
      ],
    ]);
    const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
    await type(stdin, "hi");
    await tick(150);
    expect(lastFrame()).toContain("1.2k tokens · 83% cached");
  });

  describe("compaction", () => {
    const step = (text: string, promptTokens: number): AgentEvent[] => [
      { type: "text_delta", text },
      { type: "usage", usage: { promptTokens, completionTokens: 10 } },
      { type: "done" },
    ];

    test("near a full context, the next message first compacts the conversation", async () => {
      const model = new ScriptedProvider(
        [step("first answer", 900), step("SUMMARY: user asked a question; answered.", 950), step("second answer", 120)],
        1000,
      );
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
      await type(stdin, "one");
      await tick(150);
      expect(lastFrame()).toContain("910/1k ctx");

      await type(stdin, "two");
      await tick(300);
      // Request 2 asked for a summary; request 3 carried on from it.
      expect((model.requests[1]!.history.at(-1) as { text: string }).text).toContain("Summarize our conversation");
      expect(model.requests[2]!.history).toEqual([
        { role: "user", text: expect.stringContaining("SUMMARY: user asked a question; answered.") },
        { role: "assistant", text: expect.any(String) },
        { role: "user", text: "two" },
      ]);
      const frame = lastFrame()!;
      expect(frame).toContain("Compacted the conversation (the context was 91% full)");
      expect(frame).toContain("first answer"); // the transcript keeps everything
      expect(frame).toContain("second answer");
    });

    test("/compact runs on demand, with what to focus on", async () => {
      const model = new ScriptedProvider([step("answer", 100), step("SUMMARY", 120), step("next", 50)]);
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
      await type(stdin, "hello");
      await tick(150);
      await type(stdin, "/compact keep the file names");
      await tick(200);
      expect((model.requests[1]!.history.at(-1) as { text: string }).text).toContain("Focus especially on: keep the file names");
      expect(lastFrame()).toContain("Compacted the conversation: 110 → about");
    });

    test("/compact with nothing to compact says so", async () => {
      const { lastFrame, stdin } = renderApp(LOCAL);
      await type(stdin, "/compact");
      await tick();
      expect(lastFrame()).toContain("Nothing to compact yet.");
    });

    test("Esc stops a compaction and changes nothing", async () => {
      const slowSummary: Provider = {
        name: "slow",
        async *stream(history, options) {
          if ((history.at(-1) as { text: string }).text.includes("Summarize")) {
            while (!options?.signal?.aborted) await Bun.sleep(10);
            return;
          }
          yield { type: "text_delta", text: "answer" };
          yield { type: "done" };
        },
      };
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => slowSummary);
      await type(stdin, "hello");
      await tick(150);
      await type(stdin, "/compact");
      await tick(100);
      expect(lastFrame()).toContain("Compacting the conversation…");
      stdin.write("\x1b");
      await tick(250);
      expect(lastFrame()).toContain("Compaction stopped; nothing changed.");
    });
  });

  test("puts AGENTS.md in the system prompt and says it's loaded", async () => {
    const model = new ScriptedProvider([[{ type: "text_delta", text: "ok" }, { type: "done" }]]);
    const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model, "Always answer in haiku.");
    expect(lastFrame()).toContain("AGENTS.md loaded");
    await type(stdin, "hi");
    await tick(100);
    expect(model.requests[0]!.options.system).toContain("Always answer in haiku.");
  });

  describe("approvals", () => {
    const writeCall = (id: string, path: string) =>
      [{ type: "tool_call", call: { id, name: "write_file", arguments: JSON.stringify({ path, content: "hello\n" }) } }, { type: "done" }] as AgentEvent[];
    const reply = (text: string) => [{ type: "text_delta", text }, { type: "done" }] as AgentEvent[];

    test("a change waits for approval, then runs and the model carries on", async () => {
      const model = new ScriptedProvider([writeCall("c1", "made.txt"), reply("Created it.")]);
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
      await type(stdin, "make a file");
      await tick(150);
      expect(lastFrame()).toContain("Create made.txt");
      expect(lastFrame()).toContain("Do you want to proceed?");
      expect(existsSync(join(project, "made.txt"))).toBe(false); // nothing happens before the answer

      stdin.write(ENTER); // Yes
      await tick(200);
      expect(await Bun.file(join(project, "made.txt")).text()).toBe("hello\n");
      expect(lastFrame()).toContain("⎿ created · 1 line");
      expect(lastFrame()).toContain("Created it.");
      expect(lastFrame()).not.toContain("Do you want to proceed?");
    });

    test("no stops the agent and leaves the file alone", async () => {
      const model = new ScriptedProvider([writeCall("c1", "made.txt"), reply("should not get here")]);
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
      await type(stdin, "make a file");
      await tick(150);
      stdin.write(DOWN);
      await tick();
      stdin.write(DOWN);
      await tick();
      stdin.write(ENTER); // No
      await tick(200);
      expect(existsSync(join(project, "made.txt"))).toBe(false);
      expect(lastFrame()).toContain("⎿ declined");
      expect(lastFrame()).toContain("Stopped. Tell Marv what to do instead.");
      expect(model.requests).toHaveLength(1);
    });

    test("'don't ask again' covers later changes this session", async () => {
      const model = new ScriptedProvider([writeCall("c1", "one.txt"), writeCall("c2", "two.txt"), reply("Both done.")]);
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
      await type(stdin, "make two files");
      await tick(150);
      stdin.write(DOWN);
      await tick();
      stdin.write(ENTER); // Yes, and don't ask again
      await tick(300);
      expect(existsSync(join(project, "one.txt"))).toBe(true);
      expect(existsSync(join(project, "two.txt"))).toBe(true); // no second prompt
      expect(lastFrame()).toContain("Both done.");
    });

    test("ctrl+c at the prompt declines and stops", async () => {
      const model = new ScriptedProvider([writeCall("c1", "made.txt")]);
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
      await type(stdin, "make a file");
      await tick(150);
      stdin.write("\x03");
      await tick(200);
      expect(existsSync(join(project, "made.txt"))).toBe(false);
      expect(lastFrame()).toContain("Interrupted.");
      expect(lastFrame()).toContain("Type a message");
    });
  });

  describe("skills", () => {
    const review: Skill = { name: "review", description: "Review code for bugs.", body: "Look for off-by-one errors.", dir: "/x/review", files: [], source: "project" };

    test("the model is offered the skill tool and the list of skills", async () => {
      const model = new ScriptedProvider([[{ type: "text_delta", text: "ok" }, { type: "done" }]]);
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model, undefined, [review]);
      expect(lastFrame()).toContain("1 skill (/skills)");
      await type(stdin, "hi");
      await tick(100);
      expect(model.requests[0]!.options.tools!.map((t) => t.name)).toContain("skill");
      expect(model.requests[0]!.options.system).toContain("- review: Review code for bugs.");
    });

    test("without skills, there's no skill tool", async () => {
      const model = new ScriptedProvider([[{ type: "text_delta", text: "ok" }, { type: "done" }]]);
      const { stdin } = renderApp(LOCAL, 0, undefined, () => model);
      await type(stdin, "hi");
      await tick(100);
      expect(model.requests[0]!.options.tools!.map((t) => t.name)).not.toContain("skill");
    });

    test("/review args sends the skill's instructions with the request, but shows what you typed", async () => {
      const model = new ScriptedProvider([[{ type: "text_delta", text: "Reviewed." }, { type: "done" }]]);
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model, undefined, [review]);
      stdin.write("/rev");
      await tick();
      expect(lastFrame()).toContain("/review"); // in the / menu
      expect(lastFrame()).toContain("Review code for bugs.");
      stdin.write("iew src/app.tsx");
      await tick();
      stdin.write(ENTER);
      await tick(150);
      const sent = model.requests[0]!.history.at(-1)!;
      expect(sent.role).toBe("user");
      expect((sent as { text: string }).text).toContain("Look for off-by-one errors.");
      expect((sent as { text: string }).text).toContain("src/app.tsx");
      expect(lastFrame()).toContain("> /review src/app.tsx");
      expect(lastFrame()).not.toContain("off-by-one");
    });

    test("skills that couldn't be loaded are reported at startup", async () => {
      const { lastFrame } = renderApp(LOCAL, 0, undefined, undefined, undefined, [], [".marv/skills/x/SKILL.md needs a description"]);
      await tick();
      expect(lastFrame()).toContain("1 skill couldn't be loaded (see /skills)");
    });
  });

  test("Esc interrupts a running reply", async () => {
    const slow: Provider = {
      name: "slow",
      async *stream(_history, options) {
        for (let i = 0; i < 100 && !options?.signal?.aborted; i++) {
          await Bun.sleep(20);
          yield { type: "text_delta", text: "word " };
        }
        yield { type: "done" };
      },
    };
    const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => slow);
    await type(stdin, "go");
    await tick(150);
    expect(lastFrame()).toContain("esc to interrupt");
    stdin.write("\x1b");
    await tick(250); // a lone ESC is held briefly to tell it apart from escape sequences
    expect(lastFrame()).toContain("Interrupted.");
    expect(lastFrame()).toContain("Type a message");
  });

  describe("tokens and cost", () => {
    const reply = (usage: Record<string, number>) =>
      [{ type: "text_delta", text: "ok" }, { type: "usage", usage }, { type: "done" }] as AgentEvent[];

    function renderOpenRouter(model: Provider, models: ModelInfo[]) {
      return render(
        <App
          store={store}
          initialFile={{ provider: "openrouter", model: "acme/model", apiKey: "sk-or-test" }}
          env={{}}
          version="9.9.9"
          cwd="~/x"
          root={project}
          splashMs={0}
          makeProvider={() => model}
          loadModels={async () => models}
        />,
      );
    }

    test("shows the reported cost, and the context window from the model list", async () => {
      const model = new ScriptedProvider([
        reply({ promptTokens: 12_000, completionTokens: 300, cachedTokens: 0, cost: 0.0251 }),
        reply({ promptTokens: 12_400, completionTokens: 200, cachedTokens: 12_000, cost: 0.0042 }),
      ]);
      const { lastFrame, stdin } = renderOpenRouter(model, [{ id: "acme/model", tools: true, context: 200_000 }]);
      await tick();
      await type(stdin, "one");
      await tick(150);
      expect(lastFrame()).toContain("12.3k/200k ctx · 0% cached · $0.025");
      await type(stdin, "two");
      await tick(150);
      expect(lastFrame()).toContain("$0.029"); // the session total

      await type(stdin, "/cost");
      await tick();
      const frame = lastFrame()!;
      expect(frame).toContain("This session: 2 requests");
      expect(frame).toContain("24.4k input tokens (12k from the cache, 49%)");
      expect(frame).toContain("Cost: $0.029");
      expect(frame).toContain("Context: 12.6k of 200k tokens (6%)");
    });

    test("estimates the cost from the model's prices when none is reported", async () => {
      const model = new ScriptedProvider([reply({ promptTokens: 10_000, completionTokens: 1000 })]);
      const { lastFrame, stdin } = renderOpenRouter(model, [{ id: "acme/model", tools: true, priceIn: 2, priceOut: 10 }]);
      await tick();
      await type(stdin, "hi");
      await tick(150);
      expect(lastFrame()).toContain("~$0.030"); // 10k in at $2/M + 1k out at $10/M
    });

    test("a local model costs nothing", async () => {
      const model = new ScriptedProvider([reply({ promptTokens: 900, completionTokens: 10 })], 32_768);
      const { lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
      await type(stdin, "hi");
      await tick(150);
      expect(lastFrame()).toContain("910/32.8k ctx · local");
    });
  });

  describe("sessions", () => {
    let sessions: SessionStore;
    beforeEach(() => {
      sessions = new SessionStore(join(dir, "sessions"));
    });

    function renderWithSessions(model: Provider, resume?: "latest" | "pick") {
      return render(
        <App
          store={store}
          initialFile={LOCAL}
          env={{}}
          version="9.9.9"
          cwd="~/x"
          root={project}
          splashMs={0}
          makeProvider={() => model}
          loadModels={async () => []}
          sessions={sessions}
          resume={resume}
        />,
      );
    }
    const say = (text: string) => [{ type: "text_delta", text }, { type: "done" }] as AgentEvent[];

    test("each turn is saved, with both the transcript and the conversation", async () => {
      const { stdin } = renderWithSessions(new ScriptedProvider([say("Paris.")]));
      await type(stdin, "capital of France?");
      await tick(500);
      const [summary] = await sessions.list(project);
      expect(summary).toMatchObject({ title: "capital of France?", messages: 2 });
      const saved = await sessions.load(project, summary!.id);
      expect(saved!.conversation).toEqual([
        { role: "user", text: "capital of France?" },
        { role: "assistant", text: "Paris." },
      ]);
    });

    test("/resume picks an earlier session and carries on from it", async () => {
      // An earlier session…
      const first = renderWithSessions(new ScriptedProvider([say("Paris.")]));
      await type(first.stdin, "capital of France?");
      await tick(500);
      first.unmount();

      // …picked up in a new one.
      const model = new ScriptedProvider([say("About 2.1 million.")]);
      const { lastFrame, stdin } = renderWithSessions(model);
      await type(stdin, "/resume");
      await tick(150);
      expect(lastFrame()).toContain("Resume a session");
      expect(lastFrame()).toContain("capital of France?");
      stdin.write(ENTER);
      await tick(200);
      expect(lastFrame()).toContain("Paris."); // the old transcript is back
      expect(lastFrame()).toContain("Resumed");

      await type(stdin, "and its population?");
      await tick(200);
      // The model gets the earlier conversation too.
      expect(model.requests[0]!.history).toEqual([
        { role: "user", text: "capital of France?" },
        { role: "assistant", text: "Paris." },
        { role: "user", text: "and its population?" },
      ]);
      await tick(400);
      expect(await sessions.list(project)).toHaveLength(1); // still the same session
    });

    test("--continue resumes the latest session at startup", async () => {
      const first = renderWithSessions(new ScriptedProvider([say("Paris.")]));
      await type(first.stdin, "capital of France?");
      await tick(500);
      first.unmount();

      const { lastFrame } = renderWithSessions(new ScriptedProvider([]), "latest");
      await tick(300);
      expect(lastFrame()).toContain("capital of France?");
      expect(lastFrame()).toContain("Paris.");
    });

    test("/resume with nothing saved says so", async () => {
      const { lastFrame, stdin } = renderWithSessions(new ScriptedProvider([]));
      await type(stdin, "/resume");
      await tick(150);
      expect(lastFrame()).toContain("No saved sessions for this project yet.");
    });

    test("/clear starts a new session and keeps the old one", async () => {
      const { stdin } = renderWithSessions(new ScriptedProvider([say("one"), say("two")]));
      await type(stdin, "first");
      await tick(500);
      await type(stdin, "/clear");
      await tick();
      await type(stdin, "second");
      await tick(500);
      expect((await sessions.list(project)).map((s) => s.title)).toEqual(["second", "first"]);
    });
  });
});
