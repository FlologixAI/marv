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

  test("warns once when the context window is nearly full", async () => {
    const step = (): AgentEvent[] => [
      { type: "text_delta", text: "ok" },
      { type: "usage", usage: { promptTokens: 900, completionTokens: 10 } },
      { type: "done" },
    ];
    const model = new ScriptedProvider([step(), step()], 1000);
    const { frames, lastFrame, stdin } = renderApp(LOCAL, 0, undefined, () => model);
    await type(stdin, "one");
    await tick(150);
    expect(lastFrame()).toContain("Context is 91% full");
    expect(lastFrame()).toContain("910/1k ctx");
    await type(stdin, "two");
    await tick(150);
    expect(lastFrame()!.match(/Context is \d+% full/g)).toHaveLength(1);
    expect(frames.length).toBeGreaterThan(0);
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
});
