// Which project MCP servers the user has agreed to run. A server is a program
// Marv starts with the user's permissions, outside the sandbox, so one listed
// in a project's .mcp.json (a cloned repository, or a file an agent edited)
// only starts once the user trusts it. Trust is for that project and that
// exact config: change the command, and it needs trusting again.
//
//   ~/.marv/mcp-trust.json  { "<project key>": ["<server config key>", …] }
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { projectKey } from "../paths.ts";
import { writePrivate } from "../private-file.ts";
import type { McpServerConfig } from "./config.ts";

/** Project key → the keys of the server configs trusted there. */
const TrustedSchema = z.record(z.string(), z.array(z.string()));
type Trusted = z.infer<typeof TrustedSchema>;

export class McpTrust {
  constructor(readonly path: string) {}

  private async read(): Promise<Trusted> {
    if (!existsSync(this.path)) return {};
    try {
      // Valid JSON of the wrong shape (a hand edit: null, a list, a string) is as unreadable as broken JSON.
      const parsed = TrustedSchema.safeParse(await Bun.file(this.path).json());
      return parsed.success ? parsed.data : {};
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
