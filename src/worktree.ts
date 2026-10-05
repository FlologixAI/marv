// Git worktrees for subagents: a second checkout of the same repository, on
// its own branch, so agents working in parallel don't edit the same files.
//
//   git worktree add -b marv/<task>-<id> ~/.marv/worktrees/<project>/<task>-<id> HEAD
//
// Inside the sandbox a subagent can change only its worktree's files: the
// repository's .git is visible read-only (git status, diff and log work), so
// it can't plant hooks or config that git would later run outside the
// sandbox. When it's done, Marv commits its changes to the branch, removes the
// folder and keeps the branch, which the parent agent reviews and merges.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ToolError } from "./tools/types.ts";

export interface Worktree {
  dir: string;
  branch: string;
  /** Short hash of the commit it started from. */
  base: string;
  /** The main checkout (the project root). */
  repo: string;
  /** The repository's shared .git folder (the sandbox shows it read-only). */
  gitDir: string;
  /** This worktree's own folder inside it (.git/worktrees/<id>): its HEAD and index. */
  adminDir: string;
}

export const NOT_A_REPO =
  'isolation: "worktree" needs a git repository with at least one commit. Start the agent without isolation instead.';

/** Hooks and fsmonitor are how a repository makes git run a program; Marv's own git calls turn both off. */
export const NO_PROGRAMS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** The environment without inherited GIT_* variables (a parent git or hook could have set GIT_DIR, GIT_INDEX_FILE…), plus `pinned`. */
export function gitEnvironment(pinned: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  return { ...env, ...pinned };
}

function git(cwd: string, args: string[], pinned?: Record<string, string>): { ok: boolean; out: string } {
  const result = Bun.spawnSync(["git", ...NO_PROGRAMS, ...args], { cwd, env: gitEnvironment(pinned), stdout: "pipe", stderr: "pipe" });
  const ok = result.exitCode === 0;
  return { ok, out: (ok ? result.stdout : result.stderr).toString().trim() };
}

/**
 * Where git must look for a worktree a subagent has used. The worktree's
 * `.git` file was within the subagent's reach and could point at a fake
 * repository with its own config, so Marv's git outside the sandbox (e.g. the
 * file listing behind glob and grep) never reads it. The finishing commit
 * goes further and doesn't use the worktree's record either (`commitGitDir`).
 */
export const worktreeEnv = (wt: Worktree) => ({ GIT_DIR: wt.adminDir, GIT_COMMON_DIR: wt.gitDir, GIT_WORK_TREE: wt.dir });

/**
 * A git dir of Marv's own for the finishing commit: HEAD on the worktree's
 * branch, the repository's real .git as `commondir`, and a copy of the index
 * (which only saves re-reading unchanged files; without it, `add -A` stages
 * everything from scratch). Pinning GIT_DIR to the worktree's record
 * (.git/worktrees/<id>) isn't enough: git finds branches through that folder's
 * `commondir` file even when GIT_COMMON_DIR is set, follows its HEAD, and,
 * in a repository with per-worktree config, reads its `config.worktree`, where
 * a filter could run a program. The sandbox shows that folder read-only; this
 * is the second layer.
 */
function commitGitDir(wt: Worktree): string {
  const dir = mkdtempSync(join(tmpdir(), "marv-commit-"));
  writeFileSync(join(dir, "HEAD"), `ref: refs/heads/${wt.branch}\n`);
  writeFileSync(join(dir, "commondir"), `${wt.gitDir}\n`);
  try {
    copyFileSync(join(wt.adminDir, "index"), join(dir, "index"));
  } catch {
    // No index: git stages every file anew, with the same result.
  }
  return dir;
}

const repoGit = (wt: Worktree, ...args: string[]) => git(wt.repo, args);

/**
 * Another git repository inside the worktree (e.g. in a submodule's folder):
 * when git looks into it, it uses that repository's own config, which could
 * make it run a program outside the sandbox. Found anywhere, at any depth.
 * Symlinks aren't followed (git doesn't either; `readdirSync`'s `recursive`
 * would, out of the worktree and around loops). Throws if a folder can't be read.
 */
function nestedRepo(root: string): string | undefined {
  const pending = [""];
  while (pending.length > 0) {
    const folder = pending.pop()!;
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.name === ".git") {
        if (folder) return path; // the top-level one is the worktree's own pointer, which Marv's git never reads
      } else if (entry.isDirectory()) {
        pending.push(path);
      }
    }
  }
  return undefined;
}

/** What a worktree would start from, and how many uncommitted changes it would leave behind. Null outside a repo. */
export function inspectRepo(root: string): { base: string; dirty: number } | null {
  const head = git(root, ["rev-parse", "--short", "HEAD"]);
  if (!head.ok) return null;
  const status = git(root, ["status", "--porcelain"]).out;
  return { base: head.out, dirty: status ? status.split("\n").length : 0 };
}

/** "Task 2: Parser errors" → "marv/task-2-parser-errors-ab12" */
export function branchName(description: string, id = crypto.randomUUID().slice(0, 4)): string {
  const slug =
    description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return `marv/${slug}-${id}`;
}

export function createWorktree({ root, baseDir, description }: { root: string; baseDir: string; description: string }): Worktree {
  const repo = inspectRepo(root);
  if (!repo) throw new ToolError(NOT_A_REPO);
  const branch = branchName(description);
  const dir = join(baseDir, branch.slice("marv/".length));
  mkdirSync(baseDir, { recursive: true });
  const added = git(root, ["worktree", "add", "-q", "-b", branch, dir, "HEAD"]);
  if (!added.ok) throw new ToolError(`Couldn't create a worktree: ${added.out}`);
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(dir, path));
  const gitDir = absolute(git(dir, ["rev-parse", "--git-common-dir"]).out);
  const adminDir = absolute(git(dir, ["rev-parse", "--git-dir"]).out);
  return { dir, branch, base: repo.base, repo: root, gitDir, adminDir };
}

/** Commits everything in the worktree to its branch. Returns why it couldn't, or undefined. */
function commitChanges(wt: Worktree, message: string): string | undefined {
  const gitDir = commitGitDir(wt);
  const run = (...args: string[]) => git(wt.dir, args, { GIT_DIR: gitDir, GIT_COMMON_DIR: wt.gitDir, GIT_WORK_TREE: wt.dir });
  try {
    const status = run("status", "--porcelain");
    if (!status.ok) return `couldn't read the changes (${status.out}).`;
    if (!status.out) return undefined;
    const added = run("add", "-A");
    if (!added.ok) return `couldn't stage the changes (${added.out}).`;
    const committed = run("commit", "-q", "-m", message);
    if (!committed.ok) return `couldn't commit the changes (${committed.out}).`;
    if (run("status", "--porcelain").out) return "some changes couldn't be committed.";
    return undefined;
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
  }
}

/**
 * Commits the subagent's changes, removes the worktree and keeps the branch
 * (or deletes it if nothing was committed). Returns the line the parent agent
 * reads. If anything can't be committed, the folder is kept and its path
 * reported, so no work is lost.
 */
export function finishWorktree(wt: Worktree, { description, interrupted }: { description: string; interrupted: boolean }): string {
  const keep = (why: string) => `Branch ${wt.branch}: ${why} The changes are still in ${wt.dir}.`;
  let nested: string | undefined;
  try {
    nested = nestedRepo(wt.dir);
  } catch (error) {
    return keep(`couldn't look through the worktree (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (nested) return keep(`the worktree contains another git repository (${nested}), so Marv didn't commit it automatically.`);
  const problem = commitChanges(wt, `marv: ${description}${interrupted ? " (interrupted)" : ""}`);
  if (problem) return keep(problem);
  const commits = repoGit(wt, "rev-list", "--count", `${wt.base}..${wt.branch}`);
  if (!commits.ok) return keep(`couldn't count its commits (${commits.out}).`);
  const count = Number(commits.out);
  // Delete the folder and this worktree's own record directly. `git worktree remove` would read inside the
  // worktree, and `git worktree prune` would also drop the user's worktrees whose folders are missing right now.
  rmSync(wt.dir, { recursive: true, force: true });
  rmSync(wt.adminDir, { recursive: true, force: true });
  if (count === 0) {
    repoGit(wt, "branch", "-D", wt.branch);
    return `No changes (branch ${wt.branch} removed).`;
  }
  return `Branch ${wt.branch}: ${count} commit${count === 1 ? "" : "s"} on ${wt.base}. Review it with \`git diff ${wt.base}...${wt.branch}\`, then merge it.`;
}
