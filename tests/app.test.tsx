import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app.tsx";
import { ConfigStore, type Config, type FileConfig } from "../src/config/config.ts";
import { mouse } from "../src/mouse.ts";
import { EchoProvider } from "../src/provider/echo.ts";
import type { ChatTurn, Provider, StreamOptions } from "../src/provider/types.ts";
import { selection } from "../src/selection.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

// Let React and the async provider stream settle.
const tick = (ms = 50) => Bun.sleep(ms);

async function type(stdin: { write: (data: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write(ENTER);
}

const ECHO: FileConfig = { provider: "echo" };

let dir: string;
let store: ConfigStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ekko-app-"));
  store = new ConfigStore(dir);
});
afterEach(async () => {
  cleanup();
  await rm(dir, { recursive: true, force: true });
});

function renderApp(
  initialFile: FileConfig | null,
  splashMs = 0,
  copy = async (_text: string) => "test",
  makeProvider: (config: Config) => Provider = () => new EchoProvider(0),
) {
  return render(
    <App
      store={store}
      initialFile={initialFile}
      env={{}}
      version="9.9.9"
      cwd="~/x"
      splashMs={splashMs}
      makeProvider={makeProvider}
      copy={copy}
      loadModels={async () => [{ id: "qwen3.5:9b", local: true, tools: true }]}
    />,
  );
}

describe("App", () => {
  test("shows the splash, then the main view after a key press", async () => {
    const { lastFrame, stdin } = renderApp(ECHO, 60_000);
    expect(lastFrame()).toContain("press any key");

    stdin.write("x");
    await tick();
    expect(lastFrame()).toContain("Welcome to ekko");
  });

  test("first run opens setup and saves the result", async () => {
    const { lastFrame, frames, stdin } = renderApp(null);
    await tick();
    expect(lastFrame()).toContain("ekko setup");

    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER); // Echo
    await tick();

    expect(await store.load()).toEqual(ECHO);
    await tick(); // the "Saved" notice renders just after the file is written
    expect(frames.join("\n")).toContain("Saved to");
    expect(lastFrame()).toContain("Type a message");
  });

  test("echoes a message back through the provider stream", async () => {
    const { frames, stdin } = renderApp(ECHO);
    await type(stdin, "hello world");
    await tick(200);
    expect(frames.join("\n")).toContain("You said: hello world");
  });

  test("/help prints the command list", async () => {
    const { frames, stdin } = renderApp(ECHO);
    await type(stdin, "/help");
    await tick();
    expect(frames.join("\n")).toContain("Clear the conversation");
  });

  test("/config shows the provider and model", async () => {
    const { frames, stdin } = renderApp(ECHO);
    await type(stdin, "/config");
    await tick();
    const output = frames.join("\n");
    expect(output).toContain("Provider:  Echo");
    expect(output).toContain("API key:   not needed");
  });

  test("dragging over text copies it and says so", async () => {
    const copied: string[] = [];
    const { lastFrame } = renderApp(ECHO, 0, async (text) => {
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
    const { stdin } = renderApp(ECHO, 0, undefined, () => spy);
    await type(stdin, "first");
    await tick(100);
    await type(stdin, "second");
    await tick(100);

    expect(calls[0]!.options?.system).toContain("You are ekko");
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
    const { lastFrame, stdin } = renderApp(ECHO, 0, undefined, () => thinker);
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
});
