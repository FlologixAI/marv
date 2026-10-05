// Which MCP servers to connect to. The format is Claude Code's, so the same
// files work in both:
//
//   .mcp.json (the project)  and  ~/.marv/mcp.json (yours, every project)
//   { "mcpServers": {
//       "files": { "command": "npx", "args": ["-y", "some-server"], "env": { … } },
//       "docs":  { "type": "http", "url": "https://…/mcp", "headers": { "Authorization": "Bearer ${TOKEN}" } } } }
//
// ${VAR} and ${VAR:-default} are filled in from the environment, so tokens
// can stay out of the file. A project's servers only start once the user
// trusts them (src/mcp/trust.ts): a cloned repository could otherwise run any
// program the moment Marv starts.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Env } from "../config/config.ts";

export const PROJECT_FILE = ".mcp.json";
export const PERSONAL_FILE = "mcp.json";

export type McpTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface McpServerConfig {
  name: string;
  source: "project" | "personal";
  transport: McpTransport;
  /** Seconds a tool call may take (default 120). */
  timeout?: number;
  /** Identifies this exact config (before ${VAR}s are filled in): trust is given to it, and lost when it changes. */
  key: string;
}

const strings = z.record(z.string(), z.string());
const Stdio = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: strings.optional(),
  timeout: z.number().positive().optional(),
});
const Http = z.object({
  type: z.enum(["http", "streamable-http"]),
  url: z.string().min(1),
  headers: strings.optional(),
  timeout: z.number().positive().optional(),
});
const FileSchema = z.object({ mcpServers: z.record(z.string(), z.unknown()).optional() });

/** Server names become part of tool names (mcp__<server>__<tool>), which providers restrict. */
const NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** Fills in ${VAR} and ${VAR:-default}; throws naming the first variable that isn't set. */
function expand(text: string, env: Env): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const value = env[name] ?? fallback;
    if (value === undefined) throw new Error(`\${${name}} isn't set`);
    return value;
  });
}
const expandAll = (values: Record<string, string> | undefined, env: Env) =>
  values && Object.fromEntries(Object.entries(values).map(([k, v]) => [k, expand(v, env)]));

function parseServer(name: string, raw: unknown, source: McpServerConfig["source"], env: Env, where: string): McpServerConfig {
  if (!NAME.test(name)) throw new Error(`"${name}" in ${where}: use letters, digits, - and _ (at most 32)`);
  const type = (raw as { type?: unknown } | null)?.type;
  if (type === "sse") throw new Error(`"${name}" in ${where}: the old sse transport isn't supported; most servers also speak "type": "http"`);
  const key = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  const fail = (err: unknown) => new Error(`"${name}" in ${where}: ${err instanceof Error ? err.message : String(err)}`);
  if (type === "http" || type === "streamable-http") {
    const parsed = Http.safeParse(raw);
    if (!parsed.success) throw fail(z.prettifyError(parsed.error));
    try {
      const { url, headers, timeout } = parsed.data;
      return { name, source, key, timeout, transport: { type: "http", url: expand(url, env), ...(headers ? { headers: expandAll(headers, env) } : {}) } };
    } catch (err) {
      throw fail(err);
    }
  }
  const parsed = Stdio.safeParse(raw);
  if (!parsed.success) throw fail(z.prettifyError(parsed.error));
  try {
    const { command, args, env: serverEnv, timeout } = parsed.data;
    return {
      name,
      source,
      key,
      timeout,
      transport: {
        type: "stdio",
        command: expand(command, env),
        ...(args ? { args: args.map((a) => expand(a, env)) } : {}),
        ...(serverEnv ? { env: expandAll(serverEnv, env) } : {}),
      },
    };
  } catch (err) {
    throw fail(err);
  }
}

async function readFile(path: string, source: McpServerConfig["source"], env: Env, problems: string[]): Promise<McpServerConfig[]> {
  if (!existsSync(path)) return [];
  let entries: [string, unknown][];
  try {
    const parsed = FileSchema.safeParse(await Bun.file(path).json());
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    entries = Object.entries(parsed.data.mcpServers ?? {});
  } catch (err) {
    problems.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const servers: McpServerConfig[] = [];
  for (const [name, raw] of entries) {
    try {
      servers.push(parseServer(name, raw, source, env, path));
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  return servers;
}

/** The servers to connect to (yours first, then the project's), and what couldn't be read, and why. */
export async function loadMcpConfig({ root, configDir, env }: { root: string; configDir: string; env: Env }) {
  const problems: string[] = [];
  const projectPath = join(root, PROJECT_FILE);
  const project = await readFile(projectPath, "project", env, problems);
  const personal = await readFile(join(configDir, PERSONAL_FILE), "personal", env, problems);
  const servers = [...personal];
  for (const server of project) {
    if (personal.some((p) => p.name === server.name)) {
      problems.push(`"${server.name}" in ${projectPath} was ignored: you have a server of your own with that name.`);
    } else {
      servers.push(server);
    }
  }
  return { servers, problems };
}
