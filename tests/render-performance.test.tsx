import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Profiler, useEffect, useState } from "react";
import { render as renderForTest } from "ink-testing-library";
import { App } from "../src/app.tsx";
import { ConfigStore } from "../src/config/config.ts";
import type { AgentEvent, Provider } from "../src/provider/types.ts";
import { Box, render, Text } from "ink";
import { renderOptions } from "../src/render-options.ts";
import { ScrollView } from "../src/ui/ScrollView.tsx";
import { Transcript, type TranscriptItem } from "../src/ui/Transcript.tsx";

// The whole transcript stays mounted inside a ScrollView, so a long session
// must not make every frame (keystroke, spinner tick, martian blink) slower.

class FakeTerminal extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 45;
  write = () => true;
}
class FakeKeyboard extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  setEncoding() {}
  read() {
    return null;
  }
  ref() {}
  unref() {}
}

const REPLY = "Each file's line count:\n\n- `src/agent.ts`: 124 lines\n- `src/app.tsx`: 433 lines\n- `src/cli.tsx`: 74 lines";

/** A long agent session: mostly tool calls, with a Markdown reply every so often. */
function session(length: number): TranscriptItem[] {
  const items: TranscriptItem[] = [{ kind: "welcome", id: "welcome" }];
  for (let i = 0; i < length; i++) {
    const message =
      i % 6 === 0
        ? { id: i, role: "assistant" as const, text: REPLY }
        : { id: i, role: "tool" as const, text: "read_file", tool: { label: `src/file${i}.ts`, status: "done" as const, summary: "124 lines" } };
    items.push({ kind: "message", id: `m${i}`, message });
  }
  return items;
}

/** Median time for a keystroke to reach the screen, with `length` transcript entries above the prompt. */
async function keystrokeMs(length: number): Promise<number> {
  let type: (text: string) => void = () => {};
  function Screen() {
    const [typed, setTyped] = useState("");
    useEffect(() => {
      type = setTyped;
    }, []);
    return (
      <Box flexDirection="column" height={45} width={120}>
        <ScrollView>
          <Transcript items={session(length)} version="0.1.0" cwd="~/x" />
        </ScrollView>
        <Box flexShrink={0} borderStyle="round">
          <Text>&gt; {typed}</Text>
        </Box>
      </Box>
    );
  }

  const times: number[] = [];
  let pressedAt = 0;
  const { unmount } = render(<Screen />, {
    ...renderOptions,
    stdout: new FakeTerminal() as unknown as NodeJS.WriteStream,
    stdin: new FakeKeyboard() as unknown as NodeJS.ReadStream,
    interactive: true,
    onRender: () => {
      if (pressedAt) times.push(performance.now() - pressedAt);
      pressedAt = 0;
    },
  });
  await Bun.sleep(100);
  for (let i = 1; i <= 7; i++) {
    pressedAt = performance.now();
    type("x".repeat(i));
    await Bun.sleep(40);
  }
  unmount();
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

test("a keystroke stays fast however long the transcript gets", async () => {
  const short = await keystrokeMs(0);
  const long = await keystrokeMs(600);
  // Before off-screen messages were skipped, 600 entries took ~2400 ms per keystroke.
  expect(long).toBeLessThan(150);
  expect(long).toBeLessThan(short * 3 + 50);
}, 30000);

test("streamed tokens reach React in batches, not one render per token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marv-stream-"));
  const tokens = 300;
  const model: Provider = {
    name: "fast",
    async *stream() {
      for (let i = 0; i < tokens; i++) {
        await Bun.sleep(1); // a token every ~1 ms
        yield { type: "text_delta", text: "word " } as AgentEvent;
      }
      yield { type: "done" } as AgentEvent;
    },
  };
  let renders = 0;
  const { stdin, lastFrame, unmount } = renderForTest(
    <Profiler id="app" onRender={() => renders++}>
      <App store={new ConfigStore(dir)} initialFile={{ provider: "ollama", model: "m" }} env={{}} version="0" cwd="~" root={dir} splashMs={0} makeProvider={() => model} loadModels={async () => []} />
    </Profiler>,
  );
  await Bun.sleep(50);
  stdin.write("go");
  await Bun.sleep(20);
  renders = 0;
  stdin.write("\r");
  while (!lastFrame()!.includes("word word word") || lastFrame()!.includes("ctrl+c to interrupt")) await Bun.sleep(10);
  unmount();
  await rm(dir, { recursive: true, force: true });
  // Unbatched, this was one render per token (~300). At ~30 updates a second it's a few dozen at most.
  expect(renders).toBeLessThan(tokens / 3);
}, 30000);
