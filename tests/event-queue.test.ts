import { expect, test } from "bun:test";
import { EventQueue } from "../src/event-queue.ts";

async function drain<T>(queue: EventQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of queue) out.push(item);
  return out;
}

test("delivers what was pushed, in order, and ends once closed and empty", async () => {
  const queue = new EventQueue<number>();
  queue.push(1);
  queue.push(2);
  const done = drain(queue);
  queue.push(3);
  queue.close();
  expect(await done).toEqual([1, 2, 3]);
});

test("a waiting reader gets the next item as soon as it's pushed", async () => {
  const queue = new EventQueue<string>();
  const next = queue[Symbol.asyncIterator]().next();
  queue.push("a");
  expect(await next).toEqual({ value: "a", done: false });
});

test("pushes after close are dropped (a subagent still winding down after its turn ended)", async () => {
  const queue = new EventQueue<number>();
  queue.push(1);
  queue.close();
  queue.push(2);
  expect(await drain(queue)).toEqual([1]);
});

test("closing wakes a waiting reader", async () => {
  const queue = new EventQueue<number>();
  const done = drain(queue);
  await Bun.sleep(0);
  queue.close();
  expect(await done).toEqual([]);
});

test("a second reader is refused, rather than silently stealing the first one's wake-up", async () => {
  const queue = new EventQueue<number>();
  const first = drain(queue);
  await Bun.sleep(0);
  expect(() => queue[Symbol.asyncIterator]()).toThrow("EventQueue has one reader");
  queue.close();
  expect(await first).toEqual([]);
});

test("two pushes then a close against an already-waiting reader: both arrive, in order, then it ends", async () => {
  const queue = new EventQueue<number>();
  const done = drain(queue);
  await Bun.sleep(0);
  queue.push(1);
  queue.push(2);
  queue.close();
  expect(await done).toEqual([1, 2]);
});

test("a reader that breaks mid-stream ends cleanly, and later pushes don't throw", async () => {
  const queue = new EventQueue<number>();
  queue.push(1);
  queue.push(2);
  const seen: number[] = [];
  for await (const item of queue) {
    seen.push(item);
    break;
  }
  expect(seen).toEqual([1]);
  expect(() => {
    queue.push(3);
    queue.close();
  }).not.toThrow();
});
