import { homedir } from "node:os";

/** /home/me/projects/x → ~/projects/x, for display only. */
export function shortenHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}
