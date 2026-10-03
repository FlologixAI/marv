import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

// Configuration comes from two layers, and the later one wins:
//   1. ~/.ekko/config.json  (written by the setup screen)
//   2. environment variables (OPENROUTER_API_KEY, EKKO_MODEL, OLLAMA_HOST)
// The file is what we save; the resolved Config is what the app runs with.

export const PROVIDERS = ["openrouter", "ollama", "echo"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

interface Preset {
  label: string;
  /** OpenAI-compatible endpoint; absent for providers that don't talk HTTP. */
  baseUrl?: string;
  /** Env var that overrides the saved key; absent when no key is needed. */
  keyEnv?: string;
  keyUrl?: string;
  /** Used until a model is picked; empty means "must pick one in setup". */
  defaultModel: string;
}

// Each provider is just a preset for the same OpenAI-compatible adapter
// (except Echo, which is a fake for trying the UI offline).
export const PRESETS: Record<ProviderId, Preset> = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    keyUrl: "openrouter.ai/settings/keys",
    defaultModel: "anthropic/claude-sonnet-5.5",
  },
  ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1", defaultModel: "" },
  echo: { label: "Echo", defaultModel: "echo" },
};

const FileConfigSchema = z.object({
  provider: z.enum(PROVIDERS).default("openrouter"),
  model: z.string().min(1).optional(),
  /** The OpenRouter key (the only provider that needs one so far). */
  apiKey: z.string().min(1).optional(),
  /** Overrides the preset endpoint, e.g. Ollama on another machine. */
  baseUrl: z.string().url().optional(),
  /** Let thinking models reason before answering (slower, often better). */
  thinking: z.boolean().optional(),
});

/** Exactly what is stored on disk. */
export type FileConfig = z.infer<typeof FileConfigSchema>;

/** What the app actually runs with, after env overrides are applied. */
export interface Config {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeySource?: "env" | "file";
  thinking: boolean;
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
  const provider = file?.provider ?? "openrouter";
  const preset = PRESETS[provider];
  const envKey = (preset.keyEnv && env[preset.keyEnv]?.trim()) || undefined;
  const apiKey = preset.keyEnv ? (envKey ?? file?.apiKey) : undefined;
  return {
    provider,
    model: env.EKKO_MODEL?.trim() || file?.model || preset.defaultModel,
    baseUrl: file?.baseUrl ?? (provider === "ollama" ? ollamaUrl(env.OLLAMA_HOST) : preset.baseUrl),
    apiKey,
    apiKeySource: envKey ? "env" : apiKey ? "file" : undefined,
    thinking: file?.thinking ?? false,
  };
}

/** OLLAMA_HOST is Ollama's own setting ("127.0.0.1:11434" or a full URL); honor it. */
function ollamaUrl(host: string | undefined): string {
  if (!host?.trim()) return PRESETS.ollama.baseUrl!;
  const url = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return `${url.replace(/\/+$/, "")}/v1`;
}

/** First run, a provider that needs a key we don't have, or no model picked yet. */
export function needsSetup(file: FileConfig | null, config: Config): boolean {
  if (file === null || !config.model) return true;
  return Boolean(PRESETS[config.provider].keyEnv) && !config.apiKey;
}

/** "sk-or-v1-abc…wxyz", enough to recognise a key without revealing it. */
export function maskKey(key: string): string {
  return key.length > 16 ? `${key.slice(0, 10)}…${key.slice(-4)}` : "****";
}
