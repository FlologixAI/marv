// The public entry point: `import { createSession } from "marv/sdk"`.
//
// A session is Marv without its terminal: the agent loop, the tools, subagents, MCP servers, compaction, saved
// sessions and trajectories, driven by your code. createSession() reads nothing from disk unless asked
// (`sources`), and without an `approve` callback only what yolo mode vouches for runs (edits outside .git,
// sandboxed commands without network); anything else goes back to the model as refused. Bun only, for now.
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
// Marv uses Bun's APIs (Bun.spawn, Bun.YAML, ...): fail with a clear message under Node instead of a stray ReferenceError.
if (typeof Bun === "undefined") throw new Error("marv/sdk runs on Bun (>= 1.3).");

import pkg from "../package.json";
import { defaultConfigDir } from "./config/config.ts";
import { parseMcpServers, type McpServerConfig } from "./mcp/config.ts";
import { McpManager } from "./mcp/manager.ts";
import { McpTrust } from "./mcp/trust.ts";
import { projectKey } from "./paths.ts";
import type { ProviderOption } from "./provider/factory.ts";
import { MarvSession, type Session } from "./session.ts";
import { SessionStore } from "./sessions.ts";
import { loadSources, type Source } from "./sources.ts";
import { TrajectoryStore } from "./trajectory.ts";
import type { ApprovalRequest, Decision, Tool } from "./tools/types.ts";
import type { Message } from "./types.ts";

/** One MCP server in .mcp.json's format (validated when the session is created; a bad entry is reported in `problems`). */
export type McpServerEntry =
  | { command: string; args?: string[]; env?: Record<string, string>; timeout?: number }
  | { type: "http" | "streamable-http"; url: string; headers?: Record<string, string>; timeout?: number };

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
  mcpServers?: Record<string, McpServerEntry>;
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
  /**
   * Continue a saved session (needs `persist`): its id, or "latest" (with nothing saved yet, a new session starts).
   * An unknown id throws. Call `session.resume()` yourself if you need what was resumed (its transcript).
   */
  resume?: string | "latest";
  /** Where Marv keeps its files (default ~/.marv, or $MARV_CONFIG_DIR). */
  configDir?: string;
}

/** true → the default store; a store → that one; false or absent → none. */
function storeFor<T>(option: boolean | T | undefined, make: () => T): T | undefined {
  if (option === true) return make();
  return option || undefined;
}

export async function createSession(options: SessionOptions): Promise<Session> {
  const root = resolve(options.cwd);
  let isFolder = false;
  try {
    isFolder = statSync(root).isDirectory();
  } catch {}
  if (!isFolder) throw new Error(`cwd ${root} isn't a folder`);
  if (options.resume && !options.persist) throw new Error("resume needs persist (there's nowhere to resume from)");
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
  // Creating the manager spawns nothing; start() does. So it only starts once the session exists (its constructor
  // can throw, e.g. an unknown provider kind), and anything that fails after that closes the session, servers included.
  const mcp = servers.length ? new McpManager(servers, { root, version: pkg.version, trust: new McpTrust(join(configDir, "mcp-trust.json")) }) : undefined;

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
  void mcp?.start();
  if (options.resume) {
    try {
      const resumed = await session.resume(options.resume);
      if (!resumed && options.resume !== "latest") throw new Error(`There's no saved session "${options.resume}" for ${root}.`);
    } catch (err) {
      await session.close();
      throw err;
    }
  }
  return session;
}

export type { Session, SessionEvent, TurnEndReason, CompactResult, Resumed } from "./session.ts";
export type { ProviderOption } from "./provider/factory.ts";
export type { Source } from "./sources.ts";
export { ToolError } from "./tools/types.ts";
export type { AgentHost, AgentProgress, Tool, ToolContext, ToolResult, ApprovalRequest, Decision, Preview, Scope } from "./tools/types.ts";
export type { Provider, AgentEvent, ChatTurn, StreamOptions, ToolCall, ToolSpec, Usage } from "./provider/types.ts";
export { OllamaProvider } from "./provider/ollama.ts";
export { OpenAICompatProvider } from "./provider/openai-compat.ts";
export type { LoopEvent } from "./agent.ts";
export type { Totals } from "./usage.ts";
export type { Message } from "./types.ts";
export type { ModelInfo } from "./provider/models.ts";
export type { Memories } from "./memory.ts";
export { SessionStore } from "./sessions.ts";
export { TrajectoryStore } from "./trajectory.ts";
