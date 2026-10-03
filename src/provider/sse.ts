// Server-sent events: how LLM APIs stream a reply over plain HTTP.
// The response body is text made of events separated by blank lines:
//
//   data: {"choices":[{"delta":{"content":"Hel"}}]}
//
//   data: {"choices":[{"delta":{"content":"lo"}}]}
//
//   data: [DONE]
//
// Lines starting with ":" are comments (keep-alives). Network chunks can
// split anywhere, even mid-line, so we buffer until we see a full event.

const EVENT_BOUNDARY = /\r?\n\r?\n/;

/** Yields the `data` payload of each event in the stream. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match: RegExpExecArray | null;
    while ((match = EVENT_BOUNDARY.exec(buffer))) {
      const data = dataOf(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (data !== null) yield data;
    }
  }

  // The stream may end without a trailing blank line.
  const data = dataOf(buffer + decoder.decode());
  if (data !== null) yield data;
}

function dataOf(event: string): string | null {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return lines.length > 0 ? lines.join("\n") : null;
}
