import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app.tsx";
import { EchoProvider } from "../src/provider/echo.ts";

const ENTER = "\r";

// Let React and the async provider stream settle.
const tick = (ms = 50) => Bun.sleep(ms);

async function type(stdin: { write: (data: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write(ENTER);
}

afterEach(() => cleanup());

describe("App", () => {
  test("shows the splash, then the main view after a key press", async () => {
    const { lastFrame, stdin } = render(<App provider={new EchoProvider(0)} version="9.9.9" cwd="~/x" splashMs={60_000} />);
    expect(lastFrame()).toContain("press any key");

    stdin.write("x");
    await tick();
    expect(lastFrame()).toContain("Welcome to ekko");
  });

  test("echoes a message back through the provider stream", async () => {
    const { frames, stdin } = render(<App provider={new EchoProvider(0)} version="9.9.9" cwd="~/x" splashMs={0} />);
    await type(stdin, "hello world");
    await tick(200);
    expect(frames.join("\n")).toContain("You said: hello world");
  });

  test("/help prints the command list", async () => {
    const { frames, stdin } = render(<App provider={new EchoProvider(0)} version="9.9.9" cwd="~/x" splashMs={0} />);
    await type(stdin, "/help");
    await tick();
    expect(frames.join("\n")).toContain("Clear the conversation");
  });
});
