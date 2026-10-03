// Copy text to the system clipboard. Terminals have no portable clipboard
// API, so try the platform's clipboard tool first. The fallback is OSC 52, an
// escape code that asks the terminal itself to set the clipboard; it also
// works over ssh, but not every terminal supports it (GNOME Console doesn't).
import type { Env } from "./config/config.ts";

/** Clipboard commands to try, in order, each reading the text on stdin. */
export function clipboardCommands(platform: string, env: Env): string[][] {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip"]];
  const commands: string[][] = [];
  if (env.WAYLAND_DISPLAY) commands.push(["wl-copy"]);
  if (env.DISPLAY) commands.push(["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]);
  return commands;
}

export const osc52 = (text: string) => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;

/** Returns how the text was copied: a command name, or "osc52" as a best effort. */
export async function copyToClipboard(text: string, env: Env = process.env): Promise<string> {
  for (const command of clipboardCommands(process.platform, env)) {
    try {
      // stdout/stderr ignored so the tool can't write over the TUI.
      const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      child.stdin.write(text);
      await child.stdin.end();
      if ((await child.exited) === 0) return command[0]!;
    } catch {
      // Not installed: try the next one.
    }
  }
  process.stdout.write(osc52(text));
  return "osc52";
}
