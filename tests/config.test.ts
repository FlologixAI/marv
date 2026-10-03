import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, ConfigStore, DEFAULT_MODEL, maskKey, needsSetup, resolveConfig } from "../src/config/config.ts";

let dir: string;
let store: ConfigStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ekko-config-"));
  store = new ConfigStore(join(dir, "nested"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("ConfigStore", () => {
  test("load returns null on first run", async () => {
    expect(await store.load()).toBeNull();
  });

  test("save then load round-trips, and the file is private (0600)", async () => {
    const config = { provider: "anthropic" as const, model: "claude-sonnet-5-5", apiKey: "sk-ant-test" };
    await store.save(config);
    expect(await store.load()).toEqual(config);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  test("fills defaults for missing fields", async () => {
    await store.save({ provider: "echo", model: DEFAULT_MODEL });
    await writeFile(store.path, "{}");
    expect(await store.load()).toEqual({ provider: "anthropic", model: DEFAULT_MODEL });
  });

  test("rejects invalid JSON and unknown providers", async () => {
    await store.save({ provider: "echo", model: DEFAULT_MODEL });
    await writeFile(store.path, "{not json");
    await expect(store.load()).rejects.toBeInstanceOf(ConfigError);

    await writeFile(store.path, JSON.stringify({ provider: "nope" }));
    await expect(store.load()).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("resolveConfig", () => {
  const file = { provider: "anthropic" as const, model: "claude-haiku-4-5", apiKey: "sk-from-file" };

  test("uses the file when no env vars are set", () => {
    expect(resolveConfig(file, {})).toEqual({ ...file, apiKeySource: "file" });
  });

  test("env vars override the file", () => {
    const config = resolveConfig(file, { ANTHROPIC_API_KEY: "sk-from-env", EKKO_MODEL: "claude-opus-5-5" });
    expect(config).toMatchObject({ apiKey: "sk-from-env", apiKeySource: "env", model: "claude-opus-5-5" });
  });

  test("defaults with no file at all", () => {
    expect(resolveConfig(null, {})).toEqual({ provider: "anthropic", model: DEFAULT_MODEL, apiKey: undefined, apiKeySource: undefined });
  });
});

describe("needsSetup", () => {
  test("on first run", () => {
    expect(needsSetup(null, resolveConfig(null, { ANTHROPIC_API_KEY: "k" }))).toBe(true);
  });
  test("when Anthropic has no key", () => {
    const file = { provider: "anthropic" as const, model: DEFAULT_MODEL };
    expect(needsSetup(file, resolveConfig(file, {}))).toBe(true);
    expect(needsSetup(file, resolveConfig(file, { ANTHROPIC_API_KEY: "k" }))).toBe(false);
  });
  test("never for echo", () => {
    const file = { provider: "echo" as const, model: DEFAULT_MODEL };
    expect(needsSetup(file, resolveConfig(file, {}))).toBe(false);
  });
});

test("maskKey hides the middle of a key", () => {
  expect(maskKey("sk-ant-api03-abcdefghijklmnop-wxyz")).toBe("sk-ant-api…wxyz");
  expect(maskKey("short")).toBe("****");
});
