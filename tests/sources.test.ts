import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMcpServers } from "../src/mcp/config.ts";
import { loadSources, type Source } from "../src/sources.ts";

let base: string;
let home: string;
let configDir: string;
let root: string;

async function skill(dir: string, name: string) {
  await mkdir(join(dir, ".marv", "skills", name), { recursive: true });
  await writeFile(join(dir, ".marv", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\nDo it.`);
}
async function agent(dir: string, name: string) {
  await mkdir(join(dir, ".marv", "agents"), { recursive: true });
  await writeFile(join(dir, ".marv", "agents", `${name}.md`), `---\nname: ${name}\ndescription: The ${name} agent\n---\nYou are ${name}.`);
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "marv-sources-"));
  home = join(base, "home");
  configDir = join(home, ".marv");
  root = join(base, "project");
  await skill(home, "mine");
  await skill(root, "theirs");
  await agent(home, "my-agent");
  await agent(root, "their-agent");
  await writeFile(join(root, "AGENTS.md"), "Project rules.");
  await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { theirs: { command: "echo" } } }));
  await writeFile(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "echo" } } }));
  await mkdir(join(configDir, "memory"), { recursive: true });
  await writeFile(join(configDir, "memory", "personal.md"), "- The user likes tabs\n");
});
afterEach(() => rm(base, { recursive: true, force: true }));

const load = (sources: Source[]) => loadSources({ root, sources, configDir, home, env: {} });
const names = (list: { name: string }[]) => list.map((x) => x.name);

test("nothing asked, nothing read", async () => {
  const loaded = await load([]);
  expect(loaded.instructions).toBeUndefined();
  expect(loaded.skills).toEqual([]);
  expect(names(loaded.agents)).toEqual(["general-purpose"]);
  expect(loaded.memory).toBeUndefined();
  expect(loaded.mcpServers).toEqual([]);
  expect(loaded.problems).toEqual([]);
});

test("user: your skills, agents, memory and MCP servers; nothing from the repository", async () => {
  const loaded = await load(["user"]);
  expect(names(loaded.skills)).toEqual(["mine"]);
  expect(names(loaded.agents)).toEqual(["general-purpose", "my-agent"]);
  expect(loaded.memory?.initial.personal).toEqual(["The user likes tabs"]);
  expect(names(loaded.mcpServers)).toEqual(["mine"]);
  expect(loaded.instructions).toBeUndefined();
});

test("project: the repository's AGENTS.md, skills, agents and .mcp.json; nothing of yours", async () => {
  const loaded = await load(["project"]);
  expect(loaded.instructions).toBe("Project rules.");
  expect(names(loaded.skills)).toEqual(["theirs"]);
  expect(names(loaded.agents)).toEqual(["general-purpose", "their-agent"]);
  expect(names(loaded.mcpServers)).toEqual(["theirs"]);
  expect(loaded.memory).toBeUndefined();
});

test("both: what the CLI loads", async () => {
  const loaded = await load(["user", "project"]);
  expect(names(loaded.skills)).toEqual(["mine", "theirs"]);
  expect(names(loaded.mcpServers)).toEqual(["mine", "theirs"]);
  expect(loaded.instructions).toBe("Project rules.");
});

test("servers given in code are parsed like .mcp.json entries, and trusted like yours", () => {
  const { servers, problems } = parseMcpServers({ fs: { command: "npx", args: ["-y", "server-fs", "${DIR}"] }, bad__name: { command: "x" } }, { DIR: "/data" });
  expect(servers).toEqual([expect.objectContaining({ name: "fs", source: "personal", transport: { type: "stdio", command: "npx", args: ["-y", "server-fs", "/data"] } })]);
  expect(problems).toEqual([expect.stringContaining("bad__name")]);
});
