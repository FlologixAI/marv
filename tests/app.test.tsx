import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app.tsx";
import { ConfigStore, type FileConfig } from "../src/config/config.ts";
import { EchoProvider } from "../src/provider/echo.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

// Let React and the async provider stream settle.
const tick = (ms = 50) => Bun.sleep(ms);

async function type(stdin: { write: (data: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write(ENTER);
}

const ECHO: FileConfig = { provider: "echo", model: "claude-opus-5-5" };

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

function renderApp(initialFile: FileConfig | null, splashMs = 0) {
  return render(
    <App
      store={store}
      initialFile={initialFile}
      env={{}}
      version="9.9.9"
      cwd="~/x"
      splashMs={splashMs}
      makeProvider={() => new EchoProvider(0)}
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
    stdin.write(ENTER); // Echo
    await tick();

    expect(await store.load()).toEqual(ECHO);
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
    expect(output).toContain("Provider:  echo");
    expect(output).toContain("API key:   not set");
  });
});
