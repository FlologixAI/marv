import { createHash } from "node:crypto";
import { homedir } from "node:os";

/** /home/me/projects/x → ~/projects/x, for display only. */
export function shortenHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

/**
 * A file or folder name per project (sessions, memory, trajectories, MCP trust):
 * "/home/me/proj" → "-home-me-proj-1a2b3c4d5e". The readable part alone isn't
 * unique ("/a-b/c" and "/a/b-c", or any two non-ASCII names of the same length,
 * would share memory, sessions and trusted MCP servers), so a hash of the whole
 * path follows it. Long paths keep their end, the part that names the project.
 */
export function projectKey(root: string): string {
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 10);
  return `${legacyProjectKey(root).slice(-MAX_SLUG)}-${hash}`;
}

const MAX_SLUG = 64;

/** The key before it had a hash, for finding data saved under it. Not unique: never use it to decide anything. */
export const legacyProjectKey = (root: string) => root.replace(/[^a-zA-Z0-9]/g, "-");
