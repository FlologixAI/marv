// The session's MCP connections: starts the servers (yours, and the project's
// once trusted), lists their tools, and keeps them as Marv tools and specs.
//
// The tool list is fixed once the servers have settled (connected or failed):
// every request must send the same tool definitions, or the provider's prompt
// cache starts over. `ready` resolves when they have; the App waits for it
// before the first request. Only trusting a project's servers (/mcp trust)
// adds tools later, which the user asked for.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { homedir } from "node:os";
import type { ToolSpec } from "../provider/types.ts";
import type { Tool } from "../tools/types.ts";
import type { McpServerConfig } from "./config.ts";
import { makeMcpTool, type McpCallResult, type McpToolInfo } from "./tool.ts";
import type { McpTrust } from "./trust.ts";

/** Long enough for `npx -y some-server` to download it the first time. */
const CONNECT_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_S = 120;
const STDERR_LINES = 20;

export type McpState = "untrusted" | "connecting" | "connected" | "failed";

export interface McpServerStatus {
  name: string;
  source: McpServerConfig["source"];
  /** "npx -y server" or the URL, as written in the config (${VAR}s unexpanded, so no secrets). */
  target: string;
  /** Environment variables it reads. */
  reads: string[];
  /** Project files its command line runs (a project server's). */
  runsProjectFiles: string[];
  state: McpState;
  /** Model-facing tool names, once connected. */
  tools: string[];
  error?: string;
  /** The end of a local server's stderr (it's kept off the screen). */
  stderr?: string;
}

interface Connection {
  config: McpServerConfig;
  state: McpState;
  client?: Client;
  transport?: Transport;
  tools: { tool: Tool; spec: ToolSpec }[];
  error?: string;
  stderr: string[];
}

const describe = ({ transport }: McpServerConfig) =>
  transport.type === "http" ? transport.url : [transport.command, ...(transport.args ?? [])].join(" ");

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class McpManager {
  /** Every tool of every connected server, in config order. Replaced (never changed) when servers connect. */
  tools: Tool[] = [];
  specs: ToolSpec[] = [];
  /** Resolves once every server Marv was allowed to start has connected or failed. */
  ready: Promise<void> = Promise.resolve();
  /** Whether `ready` has resolved (so the App knows whether to say it's waiting). */
  settled = true;
  /** Told when a server's state changes (for the UI). */
  onChange: () => void = () => {};
  private connections: Connection[];

  constructor(
    servers: McpServerConfig[],
    private readonly opts: { root: string; version: string; trust?: McpTrust; connectTimeoutMs?: number },
  ) {
    this.connections = servers.map((config) => ({ config, state: "untrusted", tools: [], stderr: [] }));
  }

  /** Starts every trusted server. Project servers the user hasn't trusted wait for /mcp trust. */
  start(): Promise<void> {
    this.settled = false;
    this.ready = (async () => {
      const trusted = await Promise.all(this.connections.map(async (c) => (this.opts.trust ? this.opts.trust.isTrusted(this.opts.root, c.config) : true)));
      await Promise.all(this.connections.filter((_, i) => trusted[i]).map((c) => this.connect(c)));
      this.rebuild();
      this.settled = true;
    })();
    return this.ready;
  }

  /** Project servers waiting for the user's trust. */
  untrusted(): McpServerConfig[] {
    return this.connections.filter((c) => c.state === "untrusted").map((c) => c.config);
  }

  /** Trusts the waiting project servers (remembered for this exact config) and starts them. */
  async trustAll(): Promise<McpServerStatus[]> {
    const waiting = this.connections.filter((c) => c.state === "untrusted");
    await this.ready;
    await this.opts.trust?.trust(
      this.opts.root,
      waiting.map((c) => c.config),
    );
    this.settled = false;
    this.ready = Promise.all(waiting.map((c) => this.connect(c))).then(() => {
      this.rebuild();
      this.settled = true;
    });
    await this.ready;
    return this.status().filter((s) => waiting.some((c) => c.config.name === s.name));
  }

  status(): McpServerStatus[] {
    return this.connections.map((c) => ({
      name: c.config.name,
      source: c.config.source,
      target: c.config.display ?? describe(c.config),
      reads: c.config.reads ?? [],
      runsProjectFiles: c.config.runsProjectFiles ?? [],
      state: c.state,
      tools: c.tools.map((t) => t.tool.name),
      ...(c.error ? { error: c.error } : {}),
      ...(c.stderr.length ? { stderr: c.stderr.join("\n") } : {}),
    }));
  }

  private async connect(c: Connection): Promise<void> {
    c.state = "connecting";
    c.error = undefined;
    this.onChange();
    const { transport: t } = c.config;
    try {
      const transport =
        t.type === "stdio"
          ? // stderr piped, never inherited: it would scribble over the TUI. The SDK passes only a safe base
            // environment (PATH, HOME, …) plus `env`, so API keys don't reach the server.
            new StdioClientTransport({ command: t.command, args: t.args, env: t.env, cwd: this.cwdFor(c.config), stderr: "pipe" })
          : new StreamableHTTPClientTransport(new URL(t.url), { requestInit: { headers: t.headers } });
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on("data", (chunk: Buffer) => {
          c.stderr.push(...chunk.toString().split("\n").filter(Boolean));
          c.stderr.splice(0, Math.max(0, c.stderr.length - STDERR_LINES));
        });
      }
      c.transport = transport;
      const client = new Client({ name: "marv", version: this.opts.version });
      c.client = client;
      await withTimeout(client.connect(transport), this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, "connecting");
      const infos: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS, "listing tools");
        infos.push(...(page.tools as McpToolInfo[]));
        cursor = page.nextCursor;
      } while (cursor);
      const timeout = (c.config.timeout ?? DEFAULT_CALL_TIMEOUT_S) * 1000;
      const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
        client.callTool({ name, arguments: args }, undefined, { signal, timeout, resetTimeoutOnProgress: true }) as Promise<McpCallResult>;
      c.tools = infos.map((info) => makeMcpTool(c.config, info, call));
      c.state = "connected";
      // A server that exits later: its tools stay listed (the specs can't change), and calls fail with a clear error.
      client.onclose = () => {
        if (c.state === "connected") {
          c.state = "failed";
          c.error = "the server stopped";
          this.onChange();
        }
      };
    } catch (err) {
      c.state = "failed";
      c.error = err instanceof Error ? err.message : String(err);
      await c.transport?.close().catch(() => {});
    }
    this.onChange();
  }

  /** New arrays, so anything holding the old ones keeps a consistent set. Tool names must be unique across servers. */
  private rebuild() {
    const seen = new Set<string>();
    const all = this.connections.flatMap((c) => c.tools).filter(({ tool }) => !seen.has(tool.name) && seen.add(tool.name));
    this.tools = all.map((t) => t.tool);
    this.specs = all.map((t) => t.spec);
  }

  /**
   * Where a local server starts. Yours start in your home folder, never the project: they skip the trust check,
   * and `npx -y <pkg>` would run a <pkg> planted in the project's node_modules (by a command that ran without
   * asking, or a cloned repository) with your permissions. A project's servers were trusted for that project and
   * usually run its files, so they start there. Yours can still get the project as ${MARV_PROJECT_DIR}.
   */
  private cwdFor(config: McpServerConfig): string {
    return config.source === "project" ? this.opts.root : homedir();
  }

  /** Stops every server (on exit). */
  async close(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.client?.close().catch(() => {})));
  }

  /** Last resort on exit, synchronous: local servers must not outlive Marv. */
  kill(): void {
    for (const c of this.connections) {
      const pid = c.transport instanceof StdioClientTransport ? c.transport.pid : null;
      if (pid) {
        try {
          process.kill(pid);
        } catch {}
      }
    }
  }
}
