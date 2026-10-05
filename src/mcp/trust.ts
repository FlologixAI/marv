// Which project MCP servers the user has agreed to run. A server is a program
// Marv starts with the user's permissions, outside the sandbox, so one listed
// in a project's .mcp.json (a cloned repository, or a file an agent edited)
// only starts once the user trusts it. Trust is for that project and that
// exact config: change the command, and it needs trusting again.
//
//   ~/.marv/mcp-trust.json  { "<project key>": ["<server config key>", …] }
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { projectKey } from "../paths.ts";
import { writePrivate } from "../private-file.ts";
import type { McpServerConfig } from "./config.ts";

type Trusted = Record<string, string[]>;

export class McpTrust {
  constructor(readonly path: string) {}

  private async read(): Promise<Trusted> {
    if (!existsSync(this.path)) return {};
    try {
      return (await Bun.file(this.path).json()) as Trusted;
    } catch {
      return {}; // unreadable: trust nothing, ask again
    }
  }

  async isTrusted(root: string, server: McpServerConfig): Promise<boolean> {
    if (server.source === "personal") return true; // you wrote it into your own config
    return (await this.read())[projectKey(root)]?.includes(server.key) ?? false;
  }

  async trust(root: string, servers: McpServerConfig[]): Promise<void> {
    const all = await this.read();
    const key = projectKey(root);
    all[key] = [...new Set([...(all[key] ?? []), ...servers.map((s) => s.key)])];
    await writePrivate(this.path, JSON.stringify(all, null, 2));
  }
}
