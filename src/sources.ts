// What a session can read from disk, by where it lives (the SDK's `sources`):
//
//   "user"     your ~/.marv: personal skills and agents, memory (personal and this project's: both are your own
//              files, never in the repository), and your MCP servers (mcp.json).
//   "project"  the repository: AGENTS.md, .marv/skills, .marv/agents, and .mcp.json (whose servers still start
//              only once you've trusted them, with /mcp trust in the CLI).
//
// The CLI loads both (src/cli.tsx, through the loaders directly). A program using the SDK loads neither unless it
// asks: a library mustn't quietly read your files, or start a repository's servers.
import { homedir } from "node:os";
import { loadAgents, type AgentType } from "./agents.ts";
import type { Env } from "./config/config.ts";
import { loadMcpConfig, type McpServerConfig } from "./mcp/config.ts";
import { loadMemory, memoryPaths, type Memories, type MemoryPaths } from "./memory.ts";
import { loadInstructions } from "./prompt.ts";
import { loadSkills, type Skill } from "./skills.ts";

export type Source = "user" | "project";

export interface Loaded {
  instructions?: string;
  skills: Skill[];
  /** Always has the built-in general-purpose type. */
  agents: AgentType[];
  memory?: { paths: MemoryPaths; initial: Memories };
  mcpServers: McpServerConfig[];
  /** Files that couldn't be read, and why. */
  problems: string[];
}

export async function loadSources({
  root,
  sources,
  configDir,
  home = homedir(),
  env = process.env,
}: {
  root: string;
  sources: Source[];
  /** ~/.marv (or $MARV_CONFIG_DIR): memory and mcp.json live here. */
  configDir: string;
  /** Personal skills and agents live in <home>/.marv. */
  home?: string;
  env?: Env;
}): Promise<Loaded> {
  const user = sources.includes("user");
  const project = sources.includes("project");
  const bases = { root: project ? root : undefined, home: user ? home : undefined };
  const { skills, problems: skillProblems } = await loadSkills(bases);
  const { agents, problems: agentProblems } = await loadAgents(bases);
  const mcp = user || project ? await loadMcpConfig({ root, configDir, env, include: { personal: user, project } }) : { servers: [], problems: [] };
  const paths = memoryPaths(configDir, root);
  return {
    instructions: project ? await loadInstructions(root) : undefined,
    skills,
    agents,
    memory: user ? { paths, initial: await loadMemory(paths) } : undefined,
    mcpServers: mcp.servers,
    problems: [...skillProblems, ...agentProblems, ...mcp.problems],
  };
}
