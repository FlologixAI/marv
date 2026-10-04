import { maskKey, PRESETS, type Config } from "../config/config.ts";

// Slash commands are handled locally and never reach the LLM.
// Each command returns an action; the App decides how to apply it,
// which keeps this module pure and easy to test.

export type CommandAction =
  | { type: "print"; text: string; isError?: boolean }
  | { type: "clear" }
  | { type: "setup" }
  /** With an id: switch straight to it. Without: open the model picker. */
  | { type: "model"; id?: string }
  | { type: "thinking"; on: boolean }
  | { type: "exit" };

/** Read-only facts a command may need. */
export interface CommandContext {
  config: Config;
  configPath: string;
}

interface Command {
  name: string;
  description: string;
  run: (args: string, ctx: CommandContext) => CommandAction;
}

export const commands: Command[] = [
  {
    name: "help",
    description: "Show available commands",
    run: () => ({ type: "print", text: helpText() }),
  },
  {
    name: "config",
    description: "Show the current configuration",
    run: (_args, ctx) => ({ type: "print", text: configText(ctx) }),
  },
  {
    name: "setup",
    description: "Change provider, model, or API key",
    run: () => ({ type: "setup" }),
  },
  {
    name: "model",
    description: "Switch model (/model to pick, /model <id> to set)",
    run: (args) => (args ? { type: "model", id: args } : { type: "model" }),
  },
  {
    name: "think",
    description: "Toggle model thinking (/think on, /think off)",
    run: (args, { config }) => {
      const arg = args.toLowerCase();
      if (arg && arg !== "on" && arg !== "off") return { type: "print", text: "Usage: /think, /think on, or /think off", isError: true };
      return { type: "thinking", on: arg ? arg === "on" : !config.thinking };
    },
  },
  {
    name: "clear",
    description: "Clear the conversation",
    run: () => ({ type: "clear" }),
  },
  {
    name: "exit",
    description: "Quit Marv",
    run: () => ({ type: "exit" }),
  },
];

export function isCommand(input: string): boolean {
  return input.startsWith("/");
}

export function runCommand(input: string, ctx: CommandContext): CommandAction {
  const [rawName = "", ...rest] = input.slice(1).trim().split(/\s+/);
  const name = rawName.toLowerCase();
  const command = commands.find((c) => c.name === name);
  if (!command) {
    return { type: "print", text: `Unknown command: /${name}. Type /help for a list.`, isError: true };
  }
  return command.run(rest.join(" "), ctx);
}

function helpText(): string {
  const width = Math.max(...commands.map((c) => c.name.length)) + 2;
  const lines = commands.map((c) => `  /${c.name.padEnd(width)}${c.description}`);
  return ["Commands:", ...lines, "", "Shortcuts:", "  ↑/↓       input history", "  ctrl+c    clear input · press twice to exit"].join("\n");
}

function configText({ config, configPath }: CommandContext): string {
  const preset = PRESETS[config.provider];
  const key = !preset.keyEnv
    ? "not needed"
    : config.apiKey
      ? `${maskKey(config.apiKey)} (from ${config.apiKeySource === "env" ? preset.keyEnv : "config file"})`
      : "not set";
  return [
    `Provider:  ${preset.label}`,
    `Model:     ${config.model}`,
    `Thinking:  ${config.thinking ? "on" : "off"}`,
    `Endpoint:  ${config.baseUrl}`,
    ...(config.provider === "ollama" ? [`Context:   ${config.contextLength.toLocaleString("en-US")} tokens (contextLength in the config file)`] : []),
    `API key:   ${key}`,
    `File:      ${configPath}`,
  ].join("\n");
}
