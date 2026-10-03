import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { Setup } from "../src/ui/Setup.tsx";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const tick = (ms = 30) => Bun.sleep(ms);

async function press(stdin: { write: (data: string) => void }, ...keys: string[]) {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
}

afterEach(() => cleanup());

describe("Setup", () => {
  test("Anthropic: provider → model → key", async () => {
    const onComplete = mock();
    const { stdin, lastFrame } = render(<Setup initial={null} onComplete={onComplete} onCancel={() => {}} />);
    await tick();

    expect(lastFrame()).toContain("Which AI provider");
    await press(stdin, ENTER); // Anthropic (default)
    expect(lastFrame()).toContain("Which model?");
    await press(stdin, DOWN, ENTER); // Sonnet 5.5
    expect(lastFrame()).toContain("Paste your Anthropic API key");
    await press(stdin, "sk-ant-secret", ENTER);

    expect(lastFrame()).not.toContain("sk-ant-secret"); // input is masked
    expect(onComplete).toHaveBeenCalledWith({ provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "sk-ant-secret" });
  });

  test("skips the key step when ANTHROPIC_API_KEY is set", async () => {
    const onComplete = mock();
    const { stdin } = render(<Setup initial={null} envApiKey="sk-ant-from-env-123456" onComplete={onComplete} onCancel={() => {}} />);
    await tick();
    await press(stdin, ENTER, ENTER);
    expect(onComplete).toHaveBeenCalledWith({ provider: "anthropic", model: "claude-opus-5-5", apiKey: undefined });
  });

  test("Echo finishes immediately", async () => {
    const onComplete = mock();
    const { stdin } = render(<Setup initial={null} onComplete={onComplete} onCancel={() => {}} />);
    await tick();
    await press(stdin, DOWN, ENTER);
    expect(onComplete).toHaveBeenCalledWith({ provider: "echo", model: "claude-opus-5-5", apiKey: undefined });
  });

  test("Enter on an empty key keeps the saved one", async () => {
    const onComplete = mock();
    const initial = { provider: "anthropic" as const, model: "claude-opus-5-5", apiKey: "sk-ant-saved-key-0000" };
    const { stdin } = render(<Setup initial={initial} onComplete={onComplete} onCancel={() => {}} />);
    await tick();
    await press(stdin, ENTER, ENTER, ENTER);
    expect(onComplete).toHaveBeenCalledWith(initial);
  });

  test("Esc cancels", async () => {
    const onCancel = mock();
    const { stdin } = render(<Setup initial={null} onComplete={() => {}} onCancel={onCancel} />);
    await tick();
    await press(stdin, ESC);
    await tick(100); // a lone ESC is held briefly to tell it apart from escape sequences
    expect(onCancel).toHaveBeenCalled();
  });
});
