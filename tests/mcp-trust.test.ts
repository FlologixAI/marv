import { afterEach, beforeEach, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../src/mcp/config.ts";
import { McpTrust } from "../src/mcp/trust.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marv-trust-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const server = (name: string, key: string, source: McpServerConfig["source"] = "project"): McpServerConfig => ({
  name,
  source,
  key,
  transport: { type: "stdio", command: name },
});

test("your own servers are trusted; a project's only once you say so, per project and per exact config", async () => {
  const trust = new McpTrust(join(dir, "mcp-trust.json"));
  expect(await trust.isTrusted("/p", server("mine", "k0", "personal"))).toBe(true);
  expect(await trust.isTrusted("/p", server("files", "k1"))).toBe(false);

  await trust.trust("/p", [server("files", "k1")]);
  expect(await trust.isTrusted("/p", server("files", "k1"))).toBe(true);
  expect(await trust.isTrusted("/other", server("files", "k1"))).toBe(false); // another project
  expect(await trust.isTrusted("/p", server("files", "k2"))).toBe(false); // its config changed

  // Kept on disk, privately.
  expect(await new McpTrust(join(dir, "mcp-trust.json")).isTrusted("/p", server("files", "k1"))).toBe(true);
  expect(statSync(join(dir, "mcp-trust.json")).mode & 0o777).toBe(0o600);
});

test("a trust file of the wrong shape trusts nothing, and doesn't crash", async () => {
  for (const content of ["null", "[]", "5", '"x"', '{"k": 5}', '{"k": "abc"}', '{"k": [1, 2]}']) {
    const path = join(dir, "mcp-trust.json");
    await Bun.write(path, content);
    const trust = new McpTrust(path);
    expect(await trust.isTrusted("/p", server("files", "abc"))).toBe(false);
    await trust.trust("/p", [server("files", "k1")]);
    expect(await trust.isTrusted("/p", server("files", "k1"))).toBe(true);
  }
});
