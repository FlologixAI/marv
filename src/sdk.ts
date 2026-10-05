// The public entry point: `import { createSession } from "marv/sdk"`.
//
// A session is Marv without its terminal: the agent loop, the tools, subagents, MCP servers, compaction, saved
// sessions and trajectories, driven by your code. createSession() reads nothing from disk unless asked
// (`sources`), and without an `approve` callback only what yolo mode vouches for runs (edits outside .git,
// sandboxed commands without network); anything else goes back to the model as refused. Bun only, for now.
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { defaultConfigDir } from "./config/config.ts";
import { parseMcpServers, type McpServerConfig } from "./mcp/config.ts";
import { McpManager } from "./mcp/manager.ts";
import { McpTrust } from "./mcp/trust.ts";
import { projectKey } from "./paths.ts";
import type { ProviderOption } from "./provider/factory.ts";
import { MarvSession } from "./session.ts";
import { SessionStore } from "./sessions.ts";
import { loadSources, type Source } from "./sources.ts";
import { TrajectoryStore } from "./trajectory.ts";
import type { ApprovalRequest, Decision, Tool } from "./tools/types.ts";
import type { Message } from "./types.ts";

export interface SessionOptions {
  /** The project folder: the tools can't reach outside it. */
  cwd: string;
  /** { kind: "openrouter", apiKey, model? }, { kind: "ollama", model, host?, contextLength? }, or a Provider of your own. */
  provider: ProviderOption;
  /**
   * What to read from disk: "user" (~/.marv: your skills, agents, memory, MCP servers) and "project" (AGENTS.md,
   * .marv/, .mcp.json; its MCP servers still need trusting). Default: nothing. If `cwd` is your home folder,
   * "project" also finds ~/.marv's skills and agents, as the CLI does.
   */
  sources?: Source[];
  /** Replaces Marv's system prompt, or adds to it. */
  systemPrompt?: string | { append: string };
  /** Your own tools, offered next to the built-in ones. */
  tools?: Tool[];
  /**
   * MCP servers in .mcp.json's format: { name: { command, args?, env? } | { type: "http", url, headers? } }.
   * Servers given here are trusted like your own (no trust prompt) and start in your home folder, like the personal
   * servers in ~/.marv/mcp.json, so a relative path like `./server.js` won't resolve against the project: use an
   * absolute path or `${MARV_PROJECT_DIR}`. Never pass config read from a repository you don't control: use
   * `sources: ["project"]`, whose servers still need trusting.
   */
  mcpServers?: Record<string, unknown>;
  /** Asked for every call that needs a yes. Without it, only what yolo mode vouches for runs. */
  approve?: (request: ApprovalRequest) => Promise<Decision>;
  /** Run bash in the bubblewrap sandbox (default true). */
  sandbox?: boolean;
  /** Run what the sandbox confines without asking (default true). */
  yolo?: boolean;
  /** Let thinking models reason before they answer (default false). */
  thinking?: boolean;
  /** Save the conversation (true: in ~/.marv/sessions, where `marv -r` finds it). Default false. */
  persist?: boolean | SessionStore;
  /** Log every turn for later analysis (true: in ~/.marv/trajectories). Default false. */
  trajectories?: boolean | TrajectoryStore;
  /** What the user saw, saved with the session; default: the messages and replies. */
  transcript?: () => Message[];
  /** Continue a saved session (needs `persist`): its id, or "latest" (if there's none yet, a new one starts). */
  resume?: string | "latest";
  /** Where Marv keeps its files (default ~/.marv, or $MARV_CONFIG_DIR). */
  configDir?: string;
}

/** true → the default store; a store → that one; false or absent → none. */
function storeFor<T>(option: boolean | T | undefined, make: () => T): T | undefined {
  if (option === true) return make();
  return option || undefined;
}

export async function createSession(options: SessionOptions): Promise<MarvSession> {
  const root = resolve(options.cwd);
  const configDir = options.configDir ?? defaultConfigDir(process.env);
  const loaded = await loadSources({ root, sources: options.sources ?? [], configDir });
  const given = options.mcpServers ? parseMcpServers(options.mcpServers, { ...process.env, MARV_PROJECT_DIR: root }) : { servers: [], problems: [] };
  const problems = [...loaded.problems, ...given.problems];
  // Servers given in code first; one from the config files with the same name is skipped.
  const servers: McpServerConfig[] = [...given.servers];
  for (const server of loaded.mcpServers) {
    if (servers.some((s) => s.name === server.name)) problems.push(`MCP server "${server.name}" from the config files was ignored: mcpServers has one with that name.`);
    else servers.push(server);
  }
  const mcp = servers.length ? new McpManager(servers, { root, version: pkg.version, trust: new McpTrust(join(configDir, "mcp-trust.json")) }) : undefined;
  void mcp?.start();

  const session = new MarvSession({
    root,
    provider: options.provider,
    thinking: options.thinking,
    version: pkg.version,
    instructions: loaded.instructions,
    skills: loaded.skills,
    agents: loaded.agents,
    memory: loaded.memory,
    mcp,
    ownsMcp: true,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
    approve: options.approve,
    sandbox: options.sandbox,
    yolo: options.yolo,
    sessions: storeFor(options.persist, () => new SessionStore(join(configDir, "sessions"))),
    trajectories: storeFor(options.trajectories, () => new TrajectoryStore(join(configDir, "trajectories"))),
    worktreesDir: join(configDir, "worktrees", projectKey(root)),
    transcript: options.transcript,
    problems,
  });
  if (options.resume) {
    const resumed = await session.resume(options.resume);
    if (!resumed && options.resume !== "latest") {
      await session.close();
      throw new Error(`There's no saved session "${options.resume}" for ${root} (resuming needs persist).`);
    }
  }
  return session;
}

export type { MarvSession as Session, SessionEvent, TurnEndReason, CompactResult, Resumed } from "./session.ts";
export type { ProviderOption } from "./provider/factory.ts";
export type { Source } from "./sources.ts";
export { ToolError } from "./tools/types.ts";
export type { Tool, ToolContext, ToolResult, ApprovalRequest, Decision, Preview, Scope } from "./tools/types.ts";
export type { Provider, AgentEvent, ChatTurn, StreamOptions, ToolCall, ToolSpec, Usage } from "./provider/types.ts";
export { OllamaProvider } from "./provider/ollama.ts";
export { OpenAICompatProvider } from "./provider/openai-compat.ts";
export type { LoopEvent } from "./agent.ts";
export type { Totals } from "./usage.ts";
export type { Message } from "./types.ts";
export { SessionStore } from "./sessions.ts";
export { TrajectoryStore } from "./trajectory.ts";
