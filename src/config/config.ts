import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

// Configuration comes from two layers, and the later one wins:
//   1. ~/.ekko/config.json  (written by the setup screen)
//   2. environment variables (ANTHROPIC_API_KEY, EKKO_MODEL)
// The file is what we save; the resolved Config is what the app runs with.

export const PROVIDERS = ["anthropic", "echo"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const DEFAULT_MODEL = "claude-opus-5-5";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "recommended for coding" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "faster and cheaper" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "fastest, cheapest" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "most capable, priciest" },
] as const;

const FileConfigSchema = z.object({
  provider: z.enum(PROVIDERS).default("anthropic"),
  model: z.string().min(1).default(DEFAULT_MODEL),
  apiKey: z.string().min(1).optional(),
});

/** Exactly what is stored on disk. */
export type FileConfig = z.infer<typeof FileConfigSchema>;

/** What the app actually runs with, after env overrides are applied. */
export interface Config {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  apiKeySource?: "env" | "file";
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

export function defaultConfigDir(env: Env): string {
  return env.EKKO_CONFIG_DIR ?? join(homedir(), ".ekko");
}

export class ConfigStore {
  readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "config.json");
  }

  /** Returns null on first run (no file yet). Throws ConfigError if the file is broken. */
  async load(): Promise<FileConfig | null> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return null;

    let raw: unknown;
    try {
      raw = await file.json();
    } catch {
      throw new ConfigError(`${this.path} is not valid JSON.`);
    }
    const parsed = FileConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(`Invalid config in ${this.path}:\n${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  }

  async save(config: FileConfig): Promise<void> {
    // The file can hold an API key, so only the current user may read it.
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await chmod(this.path, 0o600); // `mode` above only applies when the file is first created
  }
}

export function resolveConfig(file: FileConfig | null, env: Env): Config {
  const envKey = env.ANTHROPIC_API_KEY?.trim() || undefined;
  const apiKey = envKey ?? file?.apiKey;
  return {
    provider: file?.provider ?? "anthropic",
    model: env.EKKO_MODEL?.trim() || file?.model || DEFAULT_MODEL,
    apiKey,
    apiKeySource: envKey ? "env" : apiKey ? "file" : undefined,
  };
}

/** First run, or a provider that needs a key we don't have. */
export function needsSetup(file: FileConfig | null, config: Config): boolean {
  return file === null || (config.provider === "anthropic" && !config.apiKey);
}

/** "sk-ant-api03-abc…wxyz", enough to recognise a key without revealing it. */
export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-4)}` : "****";
}
