import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivate } from "../src/private-file.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marv-private-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test("writes are private, and overlapping writes of one file never corrupt it; the last one wins", async () => {
  const file = join(dir, "sub", "session.json");
  // Big enough that the writes overlap.
  const writes = Array.from({ length: 20 }, (_, i) => writePrivate(file, JSON.stringify({ n: i, pad: "x".repeat(200_000 * ((i % 3) + 1)) })));
  await Promise.all(writes);
  expect(JSON.parse(await readFile(file, "utf8")).n).toBe(19);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "sub")).mode & 0o777).toBe(0o700);
  expect(readdirSync(join(dir, "sub"))).toEqual(["session.json"]); // no temp files left
});

test("two Marv processes writing the same file at once never corrupt it", async () => {
  const file = join(dir, "s.json");
  const writer = (id: number) =>
    Bun.spawn(["bun", "-e", `import { writePrivate } from ${JSON.stringify(join(import.meta.dir, "../src/private-file.ts"))};
      for (let i = 0; i < 40; i++) await writePrivate(${JSON.stringify(file)}, JSON.stringify({ id: ${id}, i, pad: "y".repeat(300000) }));`]);
  const procs = [writer(1), writer(2)];
  await Promise.all(procs.map((p) => p.exited));
  expect(procs.map((p) => p.exitCode)).toEqual([0, 0]);
  expect(JSON.parse(await readFile(file, "utf8")).i).toBe(39);
  expect(readdirSync(dir)).toEqual(["s.json"]);
});
