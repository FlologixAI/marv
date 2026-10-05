import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyProjectKey, projectKey } from "../src/paths.ts";
import { newSession, SessionStore, timeAgo, type Session } from "../src/sessions.ts";

let dir: string;
let store: SessionStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marv-sessions-"));
  store = new SessionStore(dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function session(root: string, firstMessage: string, at: number): Session {
  return {
    ...newSession(root, { provider: "ollama", model: "qwen3.5:9b" }, at),
    conversation: [
      { role: "user", text: firstMessage },
      { role: "assistant", text: "Sure." },
    ],
    transcript: [
      { id: 1, role: "user", text: firstMessage },
      { id: 2, role: "assistant", text: "Sure." },
    ],
  };
}

describe("SessionStore", () => {
  test("saves and loads a session, privately", async () => {
    const s = session("/home/me/proj", "fix the scroll bug", 1000);
    await store.save(s);
    expect(await store.load("/home/me/proj", s.id)).toEqual({ ...s, updatedAt: expect.any(Number) });
    const files = await readdir(join(dir, projectKey("/home/me/proj")));
    expect((await stat(join(dir, projectKey("/home/me/proj"), files[0]!))).mode & 0o777).toBe(0o600);
  });

  test("lists a project's sessions, newest first, titled by the first message", async () => {
    await store.save(session("/home/me/proj", "first task", 1000));
    await store.save({ ...session("/home/me/proj", "a much longer request that goes on and on and on about many many things", 3000) });
    await store.save(session("/home/me/other", "another project", 2000));
    const list = await store.list("/home/me/proj");
    expect(list.map((s) => s.title)).toEqual(["a much longer request that goes on and on and on about…", "first task"]);
    expect(list[0]).toMatchObject({ messages: 2, model: "qwen3.5:9b" });
  });

  test("latest returns the most recent session in this project", async () => {
    await store.save(session("/home/me/proj", "older", 1000));
    const newer = session("/home/me/proj", "newer", 5000);
    await store.save(newer);
    expect((await store.latest("/home/me/proj"))?.id).toBe(newer.id);
    expect(await store.latest("/nowhere")).toBeNull();
  });

  test("skips a damaged session file instead of failing", async () => {
    await store.save(session("/home/me/proj", "good", 1000));
    await writeFile(join(dir, projectKey("/home/me/proj"), "broken.json"), "{not json");
    expect((await store.list("/home/me/proj")).map((s) => s.title)).toEqual(["good"]);
  });

  test("sessions saved under the old project key are still found, and only this project's", async () => {
    // Before keys had a hash, /home/me/a-b and /home/me/a/b shared the folder "-home-me-a-b".
    const legacy = join(dir, legacyProjectKey("/home/me/a-b"));
    await mkdir(legacy, { recursive: true });
    const mine = session("/home/me/a-b", "my old task", 1000);
    const theirs = session("/home/me/a/b", "another project's task", 2000);
    await writeFile(join(legacy, `${mine.id}.json`), JSON.stringify(mine));
    await writeFile(join(legacy, `${theirs.id}.json`), JSON.stringify(theirs));

    expect((await store.list("/home/me/a-b")).map((s) => s.title)).toEqual(["my old task"]);
    expect((await store.list("/home/me/a/b")).map((s) => s.title)).toEqual(["another project's task"]);
    expect(await store.load("/home/me/a-b", theirs.id)).toBeNull();

    // Saving it again moves it to the new folder.
    await store.save(mine);
    expect(await readdir(legacy)).toEqual([`${theirs.id}.json`]);
    expect((await store.list("/home/me/a-b")).map((s) => s.title)).toEqual(["my old task"]);
  });

  test("doesn't save a session with nothing in it", async () => {
    await store.save(newSession("/home/me/proj", { provider: "ollama", model: "m" }));
    expect(await store.list("/home/me/proj")).toEqual([]);
  });
});

test.each([
  [30_000, "just now"],
  [5 * 60_000, "5 minutes ago"],
  [3 * 3_600_000, "3 hours ago"],
  [26 * 3_600_000, "yesterday"],
  [5 * 86_400_000, "5 days ago"],
])("timeAgo(%d ms) is %s", (ms, text) => {
  expect(timeAgo(1_000_000_000_000 - ms, 1_000_000_000_000)).toBe(text);
});
