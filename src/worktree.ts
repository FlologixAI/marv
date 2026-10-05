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
//
// Known limits:
// - Repositories that use a split index or the reftable ref format can't be
//   committed automatically (Marv's own git dir lacks their extra files); git
//   fails, so the folder is kept and reported, nothing is lost.
// - The git calls themselves are synchronous (short, with a timeout); the walk
//   for nested repositories and the folder's removal are not, so a big
//   node_modules doesn't freeze the UI.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { GIT_TIMEOUT_MS, runGit } from "./git.ts";
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
  /** Where the parent's project sits in the repository, as git says it ("pkg/", or "" at the top). */
  prefix: string;
  /**
   * Where the subagent works: the same subfolder of the worktree (`dir` + `prefix`). `git worktree add`
   * checks out the whole repository, but a session started in repo/pkg should give its subagent pkg,
   * not the whole repository. The finishing commit still covers the whole worktree.
   */
  workDir: string;
}

export const NOT_A_REPO =
  'isolation: "worktree" needs a git repository with at least one commit. Start the agent without isolation instead.';

/** Runs git for the worktree code (60 s timeout); `out` is trimmed. */
function git(cwd: string, args: string[], pinned?: Record<string, string>): { ok: boolean; out: string } {
  const result = runGit(cwd, args, { env: pinned, timeoutMs: GIT_TIMEOUT_MS });
  if (result.timedOut) return { ok: false, out: `git timed out after ${GIT_TIMEOUT_MS / 1000} s` };
  return { ok: result.ok, out: result.out.trim() };
}

/**
 * Where git must look for a worktree a subagent has used. The worktree's
 * `.git` file was within the subagent's reach and could point at a fake
 * repository with its own config, so Marv's git outside the sandbox (e.g. the
 * file listing behind glob and grep) never reads it. It still trusts the
 * worktree's record (.git/worktrees/<id>: its `config.worktree`, HEAD and
 * `commondir`), which the sandbox shows read-only, so callers must run git through
 * `runGit` (src/git.ts). The finishing commit goes
 * further and doesn't use the worktree's record at all (`commitGitDir`).
 */
export const worktreeEnv = (wt: Worktree) => ({ GIT_DIR: wt.adminDir, GIT_COMMON_DIR: wt.gitDir, GIT_WORK_TREE: wt.dir });

/**
 * A git dir of Marv's own for the finishing commit: HEAD on the worktree's
 * branch, the repository's real .git as `commondir`, and a copy of the index.
 * The copy is required, not just faster: the index is what says a file is
 * tracked even though it matches .gitignore (added with `add -f`) or is marked
 * skip-worktree, and `add -A` from an empty index would silently leave those
 * files out of the commit, i.e. delete them from the branch. So without it,
 * this throws and nothing is committed. Pinning GIT_DIR to the worktree's record
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
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

const repoGit = (wt: Worktree, ...args: string[]) => git(wt.repo, args);

/**
 * Another git repository inside the worktree (e.g. in a submodule's folder):
 * when git looks into it, it uses that repository's own config, which could
 * make it run a program outside the sandbox. Found at any depth, except in
 * `skip`: folders git ignores, which `git add -A` never looks into (so a
 * `node_modules/x/.git` or a `.venv/src/<pkg>/.git` is no reason to refuse,
 * and walking them is most of the work after an install). Symlinks aren't
 * followed (git doesn't either; `readdir`'s `recursive` would, out of the
 * worktree and around loops). Async, so a big tree doesn't freeze the UI.
 * Throws if a folder can't be read.
 */
async function nestedRepo(root: string, skip: Set<string>): Promise<string | undefined> {
  const pending = [""];
  while (pending.length > 0) {
    const folder = pending.pop()!;
    for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.name === ".git") {
        if (folder) return path; // the top-level one is the worktree's own pointer, which Marv's git never reads
      } else if (entry.isDirectory() && !skip.has(path)) {
        pending.push(path);
      }
    }
  }
  return undefined;
}

/**
 * The folders git ignores in the worktree, relative to its top ("node_modules"), listed by the same git
 * (same git dir, index and ignore rules) that then runs `add -A`. Empty if git can't list them: then
 * everything is walked (slower, never less safe).
 */
function ignoredFolders(run: (...args: string[]) => { ok: boolean; out: string }): Set<string> {
  const listed = run("ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory");
  if (!listed.ok) return new Set();
  return new Set(
    listed.out
      .split("\0")
      .filter((path) => path.endsWith("/"))
      .map((path) => path.slice(0, -1)),
  );
}

/**
 * What a worktree would start from, how many uncommitted changes it would leave behind (in the whole
 * repository, even when `root` is a subfolder of it), and where `root` sits in it ("pkg/", or "" at the top).
 * Null outside a repo.
 */
export function inspectRepo(root: string): { base: string; dirty: number; prefix: string } | null {
  const head = git(root, ["rev-parse", "--short", "HEAD"]);
  if (!head.ok) return null;
  const prefix = git(root, ["rev-parse", "--show-prefix"]);
  if (!prefix.ok) return null;
  const status = git(root, ["status", "--porcelain"]).out;
  return { base: head.out, dirty: status ? status.split("\n").length : 0, prefix: prefix.out };
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
  const workDir = resolve(dir, repo.prefix); // no trailing slash
  // A folder with no tracked files (e.g. a new package) isn't checked out: start it empty.
  mkdirSync(workDir, { recursive: true });
  return { dir, branch, base: repo.base, repo: root, gitDir, adminDir, prefix: repo.prefix, workDir };
}

/**
 * Commits everything in the worktree to its branch, unless it holds another repository (`nestedRepo`).
 * Returns why it couldn't, or undefined.
 */
async function commitChanges(wt: Worktree, message: string): Promise<string | undefined> {
  let gitDir: string;
  try {
    gitDir = commitGitDir(wt);
  } catch (error) {
    return `couldn't read the worktree's index (${errorMessage(error)}).`;
  }
  const run = (...args: string[]) => git(wt.dir, args, { GIT_DIR: gitDir, GIT_COMMON_DIR: wt.gitDir, GIT_WORK_TREE: wt.dir });
  try {
    let nested: string | undefined;
    try {
      nested = await nestedRepo(wt.dir, ignoredFolders(run));
    } catch (error) {
      return `couldn't look through the worktree (${errorMessage(error)}).`;
    }
    if (nested) return `the worktree contains another git repository (${nested}), so Marv didn't commit it automatically.`;
    const status = run("status", "--porcelain");
    if (!status.ok) return `couldn't read the changes (${status.out}).`;
    if (!status.out) return undefined;
    const added = run("add", "-A");
    if (!added.ok) return `couldn't stage the changes (${added.out}).`;
    // Unsigned, even if the repository signs commits: Marv's full-screen UI can't host a pinentry prompt, and
    // spawnSync would block the event loop while it waited, freezing every parallel subagent. The parent's merge can sign.
    const committed = run("-c", "commit.gpgSign=false", "commit", "-q", "-m", message);
    if (!committed.ok) return `couldn't commit the changes (${committed.out}).`;
    if (run("status", "--porcelain").out) return "some changes couldn't be committed.";
    return undefined;
  } finally {
    await rm(gitDir, { recursive: true, force: true });
  }
}

/**
 * Commits the subagent's changes, removes the worktree and keeps the branch
 * (or deletes it if nothing was committed). Returns the line the parent agent
 * reads. If anything can't be committed, the folder is kept and its path
 * reported, so no work is lost.
 */
export async function finishWorktree(wt: Worktree, { description, interrupted }: { description: string; interrupted: boolean }): Promise<string> {
  const keep = (why: string) => `Branch ${wt.branch}: ${why} The changes are still in ${wt.dir}.`;
  const problem = await commitChanges(wt, `marv: ${description}${interrupted ? " (interrupted)" : ""}`);
  if (problem) return keep(problem);
  const commits = repoGit(wt, "rev-list", "--count", `${wt.base}..${wt.branch}`);
  if (!commits.ok) return keep(`couldn't count its commits (${commits.out}).`);
  const count = Number(commits.out);
  // Delete the folder and this worktree's own record directly. `git worktree remove` would read inside the
  // worktree, and `git worktree prune` would also drop the user's worktrees whose folders are missing right now.
  // Everything is committed by now, so a folder that can't be removed (e.g. one the subagent made read-only) only
  // needs mentioning.
  const removed = await Promise.all([wt.dir, wt.adminDir].map(remove));
  const leftovers = [wt.dir, wt.adminDir].filter((_, i) => !removed[i]);
  const note = leftovers.map((path) => ` The folder couldn't be removed: ${path}.`).join("");
  if (count === 0) {
    repoGit(wt, "branch", "-D", wt.branch);
    return `No changes (branch ${wt.branch} removed).${note}`;
  }
  return `Branch ${wt.branch}: ${count} commit${count === 1 ? "" : "s"} on ${wt.base}. Review it with \`git diff ${wt.base}...${wt.branch}\`, then merge it.${note}`;
}

/** Deletes a folder (asynchronously: a node_modules can take seconds); false if it couldn't. */
async function remove(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
