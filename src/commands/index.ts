// Slash commands are handled locally and never reach the LLM.
// Each command returns an action; the App decides how to apply it,
// which keeps this module pure and easy to test.

export type CommandAction =
  | { type: "print"; text: string; isError?: boolean }
  | { type: "clear" }
  | { type: "exit" };

interface Command {
  name: string;
  description: string;
  run: (args: string) => CommandAction;
}

export const commands: Command[] = [
  {
    name: "help",
    description: "Show available commands",
    run: () => ({ type: "print", text: helpText() }),
  },
  {
    name: "clear",
    description: "Clear the conversation",
    run: () => ({ type: "clear" }),
  },
  {
    name: "exit",
    description: "Quit ekko",
    run: () => ({ type: "exit" }),
  },
];

export function isCommand(input: string): boolean {
  return input.startsWith("/");
}

export function runCommand(input: string): CommandAction {
  const [rawName = "", ...rest] = input.slice(1).trim().split(/\s+/);
  const name = rawName.toLowerCase();
  const command = commands.find((c) => c.name === name);
  if (!command) {
    return { type: "print", text: `Unknown command: /${name}. Type /help for a list.`, isError: true };
  }
  return command.run(rest.join(" "));
}

function helpText(): string {
  const width = Math.max(...commands.map((c) => c.name.length)) + 2;
  const lines = commands.map((c) => `  /${c.name.padEnd(width)}${c.description}`);
  return ["Commands:", ...lines, "", "Shortcuts:", "  ↑/↓       input history", "  ctrl+c    clear input · press twice to exit"].join("\n");
}
