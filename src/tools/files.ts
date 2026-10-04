// Shared file helpers for the tools: confining paths to the project, and
// listing the project's files.
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ToolError } from "./types.ts";

/** Skipped when the project isn't a git repo (inside one, .gitignore decides). */
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", "out", "coverage", ".next", ".cache", "target", ".venv", "__pycache__"]);

const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/**
 * Resolves a path the model gave us (relative to the project, or absolute) and
 * refuses anything outside the project, including via symlinks.
 */
export function resolveInProject(root: string, path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const outside = new ToolError(
    `"${path}" is outside the project (${root}). Use a path relative to the project root, like "src/app.ts".`,
  );
  if (!isInside(root, absolute)) throw outside;
  // A symlink inside the project can still point outside it.
  if (existsSync(absolute) && !isInside(realpathSync(root), realpathSync(absolute))) throw outside;
  return absolute;
}

/** "src/app.ts" for display and for the model; "." for the root itself. */
export const projectPath = (root: string, absolute: string) => relative(root, absolute).split(sep).join("/") || ".";

/**
 * Every file in the project, as project-relative paths, sorted. Inside a git
 * repo this is `git ls-files` (tracked + untracked, minus .gitignore'd), so
 * build output and dependencies stay out of the model's way.
 */
export async function listProjectFiles(root: string): Promise<string[]> {
  const git = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  let paths: string[];
  if (git.exitCode === 0) {
    paths = git.stdout
      .toString()
      .split("\0")
      .filter((p) => p && existsSync(join(root, p))); // --cached includes deleted-but-staged files
  } else {
    paths = [];
    for await (const path of new Bun.Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true })) {
      if (!path.split(sep).some((part) => IGNORED_DIRS.has(part))) paths.push(path.split(sep).join("/"));
    }
  }
  return paths.sort();
}

/** Files under `dir` (a project-relative directory, "." for everything). */
export async function filesUnder(root: string, dir: string): Promise<string[]> {
  const all = await listProjectFiles(root);
  if (dir === ".") return all;
  return all.filter((p) => p.startsWith(`${dir}/`) || p === dir);
}

export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** Crude but standard: a NUL byte in the first 8 KB means binary. */
export const looksBinary = (bytes: Uint8Array) => bytes.subarray(0, 8192).includes(0);
