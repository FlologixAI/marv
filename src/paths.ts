import { homedir } from "node:os";

/** /home/me/projects/x → ~/projects/x, for display only. */
export function shortenHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/** "/home/me/proj" → "-home-me-proj": a file or folder name per project (sessions, memory). */
export const projectKey = (root: string) => root.replace(/[^a-zA-Z0-9]/g, "-");
