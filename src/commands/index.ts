import { maskKey, PRESETS, type Config } from "../config/config.ts";
import { sandboxAvailable } from "../sandbox.ts";
import type { Skill } from "../skills.ts";

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
  | { type: "sandbox"; on: boolean }
  /** The user ran a skill: /<name> <args>. */
  | { type: "skill"; skill: Skill; args: string }
  | { type: "exit" };

/** Read-only facts a command may need. */
export interface CommandContext {
  config: Config;
  configPath: string;
  skills?: Skill[];
  /** Skills that couldn't be loaded, and why. */
  skillProblems?: string[];
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
    name: "skills",
    description: "List the skills Marv can use",
    run: (_args, { skills = [], skillProblems = [] }) => ({ type: "print", text: skillsText(skills, skillProblems) }),
  },
  {
    name: "sandbox",
    description: "Show or set the bash sandbox (/sandbox on, /sandbox off)",
    run: (args, { config }) => {
      const arg = args.toLowerCase();
      if (arg === "on" || arg === "off") return { type: "sandbox", on: arg === "on" };
      if (arg) return { type: "print", text: "Usage: /sandbox, /sandbox on, or /sandbox off", isError: true };
      return { type: "print", text: `Sandbox: ${sandboxStatus(config)}` };
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
  const skill = ctx.skills?.find((s) => s.name === name);
  if (!command && skill) return { type: "skill", skill, args: rest.join(" ") };
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
    `Sandbox:   ${sandboxStatus(config)}`,
    `Endpoint:  ${config.baseUrl}`,
    ...(config.provider === "ollama" ? [`Context:   ${config.contextLength.toLocaleString("en-US")} tokens (contextLength in the config file)`] : []),
    `API key:   ${key}`,
    `File:      ${configPath}`,
  ].join("\n");
}

function sandboxStatus(config: Config): string {
  if (!config.sandbox) return "off: bash commands run directly on your system (after approval)";
  return sandboxAvailable()
    ? "on: bash runs in bubblewrap (project writable, home hidden, no network unless asked)"
    : "on, but bubblewrap isn't available here, so bash runs WITHOUT a sandbox";
}

function skillsText(skills: Skill[], problems: string[]): string {
  const lines = skills.length
    ? ["Skills (run one with /<name>, or let Marv pick):", ...skills.map((s) => `  /${s.name}  ${s.description}${s.source === "personal" ? "  (personal)" : ""}`)]
    : ["No skills yet. Add one as .marv/skills/<name>/SKILL.md (or ~/.marv/skills/ for all projects):", "  ---", "  name: <name>", "  description: <what it does, and when to use it>", "  ---", "  <instructions>"];
  if (problems.length) lines.push("", "Couldn't load:", ...problems.map((p) => `  ${p}`));
  return lines.join("\n");
}
