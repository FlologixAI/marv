// A queue you push to from callbacks and read with `for await`: how a session merges the events of a turn's
// main loop (an iterator) with its subagents' (callbacks that fire while the main loop waits on them) into one
// ordered stream. One reader. It never applies back-pressure: callbacks can't be told to wait, and the events
// are small.

export class EventQueue<T> implements AsyncIterable<T> {
  // The backlog is expected to stay small (the reader consumes as fast as events come), so shift() is fine here;
  // it would only be slow for a huge backlog.
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T, undefined>) => void) | null = null;
  private closed = false;
  private reading = false;

  /** Adds an item; dropped once the queue is closed (the stream it belonged to is over). */
  push(item: T): void {
    if (this.closed) return;
    const reader = this.waiting;
    if (reader) {
      this.waiting = null;
      reader({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** No more items: the reader gets what's queued, then the iteration ends. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const reader = this.waiting;
    this.waiting = null;
    reader?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    // A second reader would overwrite `waiting` and leave the first one hanging forever, so refuse it up front.
    if (this.reading) throw new Error("EventQueue has one reader: it's already being read.");
    this.reading = true;
    return this.read();
  }

  private async *read(): AsyncGenerator<T, void, undefined> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T, undefined>>((resolve) => (this.waiting = resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}
