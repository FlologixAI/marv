import { describe, expect, test } from "bun:test";
import { parseSSE } from "../src/provider/sse.ts";

/** A body that arrives in the given pieces, the way network chunks split arbitrarily. */
function body(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: string[] = [];
  for await (const data of parseSSE(stream)) out.push(data);
  return out;
}

describe("parseSSE", () => {
  test("yields the data of each event", async () => {
    expect(await collect(body('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'))).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  test("reassembles events split across network chunks", async () => {
    expect(await collect(body("da", 'ta: {"a"', ":1}\n", "\ndata: x\n\n"))).toEqual(['{"a":1}', "x"]);
  });

  test("skips comments and keep-alives (lines starting with ':')", async () => {
    expect(await collect(body(": OPENROUTER PROCESSING\n\ndata: hi\n\n"))).toEqual(["hi"]);
  });

  test("handles CRLF line endings and a final event without a blank line", async () => {
    expect(await collect(body("data: one\r\n\r\ndata: two"))).toEqual(["one", "two"]);
  });

  test("joins multi-line data with newlines", async () => {
    expect(await collect(body("data: line 1\ndata: line 2\n\n"))).toEqual(["line 1\nline 2"]);
  });
});
