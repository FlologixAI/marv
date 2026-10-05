import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolError } from "../src/tools/types.ts";
import { branchName, createWorktree, finishWorktree, inspectRepo, NOT_A_REPO } from "../src/worktree.ts";

let repo: string;
let trees: string;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "marv-wt-repo-"));
  trees = await mkdtemp(join(tmpdir(), "marv-wt-trees-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(trees, { recursive: true, force: true });
});

describe("inspectRepo", () => {
  test("the base commit and how many uncommitted changes would be left behind", async () => {
    expect(inspectRepo(repo)).toEqual({ base: git(repo, "rev-parse", "--short", "HEAD"), dirty: 0 });
    await writeFile(join(repo, "b.txt"), "new\n");
    expect(inspectRepo(repo)!.dirty).toBe(1);
  });

  test("null outside a git repo", () => {
    expect(inspectRepo(trees)).toBeNull();
  });
});

test("branchName: marv/<slug>-<id>", () => {
  expect(branchName("Task 2: Parser errors!", "ab12")).toBe("marv/task-2-parser-errors-ab12");
  expect(branchName("!!!", "ab12")).toBe("marv/task-ab12");
  expect(branchName("x".repeat(80), "ab12")).toBe(`marv/${"x".repeat(40)}-ab12`);
  expect(branchName("Fix it")).toMatch(/^marv\/fix-it-[0-9a-f]{4}$/);
});

describe("createWorktree / finishWorktree", () => {
  test("a new branch in its own folder, sharing the repo's .git", () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Fix parser" });
    expect(wt.branch).toMatch(/^marv\/fix-parser-[0-9a-f]{4}$/);
    expect(wt.dir.startsWith(trees)).toBe(true);
    expect(existsSync(join(wt.dir, "a.txt"))).toBe(true);
    expect(git(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
    expect(wt.gitDir).toBe(join(repo, ".git"));
    expect(wt.adminDir).toStartWith(join(repo, ".git", "worktrees"));
    expect(wt.base).toBe(git(repo, "rev-parse", "--short", "HEAD"));
  });

  test("Marv's own git ignores a planted hook and redirected git pointers", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Sneaky" });
    const pwned = join(trees, "PWNED");
    // Plant what a subagent might, if it could write there. (In real use the sandbox shows .git read-only; this is the second layer.)
    await mkdir(join(wt.gitDir, "hooks"), { recursive: true });
    await writeFile(join(wt.gitDir, "hooks", "pre-commit"), `#!/bin/sh\ntouch ${pwned}\n`, { mode: 0o755 });
    // The worktree's .git file pointed at a fake repository whose config runs a program.
    const fake = join(trees, "fake.git");
    git(trees, "init", "-q", "--bare", fake);
    git(fake, "config", "core.fsmonitor", `touch ${pwned}`);
    await writeFile(join(wt.dir, ".git"), `gitdir: ${fake}\n`);
    await writeFile(join(wt.adminDir, "commondir"), `${fake}\n`);
    await writeFile(join(wt.dir, "b.txt"), "bee\n");

    finishWorktree(wt, { description: "Sneaky", interrupted: false });
    expect(existsSync(pwned)).toBe(false);
    expect(git(repo, "show", `${wt.branch}:b.txt`)).toBe("bee"); // committed to the real branch, not the fake repo
  });

  test("a redirected HEAD in the worktree's record doesn't move the commit to another branch", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Head" });
    await writeFile(join(wt.adminDir, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(wt.dir, "b.txt"), "bee\n");
    expect(finishWorktree(wt, { description: "Head", interrupted: false })).toContain("1 commit");
    expect(git(repo, "show", `${wt.branch}:b.txt`)).toBe("bee");
    expect(git(repo, "log", "--format=%s", "main")).toBe("first");
  });

  test("per-worktree config planted in the worktree's record doesn't run a program", async () => {
    // A repository that uses per-worktree config (git worktree's own feature) reads .git/worktrees/<id>/config.worktree.
    git(repo, "config", "core.repositoryformatversion", "1");
    git(repo, "config", "extensions.worktreeConfig", "true");
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Config" });
    const pwned = join(trees, "PWNED");
    await writeFile(join(wt.adminDir, "config.worktree"), `[filter "x"]\n\tclean = touch ${pwned} && cat\n`);
    await writeFile(join(wt.dir, ".gitattributes"), "* filter=x\n");
    await writeFile(join(wt.dir, "b.txt"), "bee\n");
    expect(finishWorktree(wt, { description: "Config", interrupted: false })).toContain("1 commit");
    expect(existsSync(pwned)).toBe(false);
  });

  test("a nested repository (e.g. in a submodule's folder) isn't committed automatically", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Nested" });
    await mkdir(join(wt.dir, "sub", ".git"), { recursive: true });
    await writeFile(join(wt.dir, "c.txt"), "c\n");
    const line = finishWorktree(wt, { description: "Nested", interrupted: false });
    expect(line).toContain("another git repository (sub/.git)");
    expect(line).toContain(`still in ${wt.dir}`);
    expect(existsSync(join(wt.dir, "c.txt"))).toBe(true);
    expect(git(repo, "rev-list", "--count", `main..${wt.branch}`)).toBe("0");
  });

  test("the search for nested repositories doesn't follow symlinks out of the worktree", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Links" });
    await mkdir(join(wt.dir, "d"));
    await symlink("..", join(wt.dir, "d", "loop"));
    await symlink(repo, join(wt.dir, "elsewhere")); // a folder with a .git inside, but not part of the worktree
    expect(finishWorktree(wt, { description: "Links", interrupted: false })).toContain("1 commit");
    expect(git(repo, "show", `${wt.branch}:elsewhere`)).toBe(repo); // committed as a link
  });

  test("a folder Marv can't read: the worktree is kept and reported, nothing thrown", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Locked" });
    await mkdir(join(wt.dir, "locked"));
    await chmod(join(wt.dir, "locked"), 0);
    try {
      const line = finishWorktree(wt, { description: "Locked", interrupted: false });
      expect(line).toContain(`still in ${wt.dir}`);
      expect(existsSync(wt.dir)).toBe(true);
    } finally {
      await chmod(join(wt.dir, "locked"), 0o755); // so afterEach can delete it
    }
  });

  test("only this worktree's record is removed, not the user's other worktrees", async () => {
    const other = join(trees, "users-own");
    git(repo, "worktree", "add", "-q", "-b", "mine", other);
    await rm(other, { recursive: true, force: true }); // e.g. on a drive that isn't mounted right now
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Tidy" });
    finishWorktree(wt, { description: "Tidy", interrupted: false });
    expect(git(repo, "worktree", "list")).toContain(other);
    expect(git(repo, "worktree", "list")).not.toContain(wt.dir);
  });

  test("inherited GIT_* variables don't redirect Marv's git", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Env" });
    await writeFile(join(wt.dir, "d.txt"), "d\n");
    process.env.GIT_INDEX_FILE = join(trees, "elsewhere-index");
    try {
      expect(finishWorktree(wt, { description: "Env", interrupted: false })).toContain("1 commit");
    } finally {
      delete process.env.GIT_INDEX_FILE;
    }
  });

  test("leftover changes are committed, the folder removed, the branch kept", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Add b" });
    await writeFile(join(wt.dir, "b.txt"), "bee\n");
    const line = finishWorktree(wt, { description: "Add b", interrupted: false });
    expect(line).toContain(`Branch ${wt.branch}: 1 commit on ${wt.base}`);
    expect(existsSync(wt.dir)).toBe(false);
    expect(git(repo, "show", `${wt.branch}:b.txt`)).toBe("bee");
    expect(git(repo, "log", "-1", "--format=%s", wt.branch)).toBe("marv: Add b");
    expect(existsSync(join(repo, "b.txt"))).toBe(false); // the main checkout is untouched
  });

  test("an interrupted subagent's work is committed and marked", async () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Half done" });
    await writeFile(join(wt.dir, "c.txt"), "c\n");
    finishWorktree(wt, { description: "Half done", interrupted: true });
    expect(git(repo, "log", "-1", "--format=%s", wt.branch)).toBe("marv: Half done (interrupted)");
  });

  test("no changes: the branch is deleted too", () => {
    const wt = createWorktree({ root: repo, baseDir: trees, description: "Nothing" });
    expect(finishWorktree(wt, { description: "Nothing", interrupted: false })).toBe(`No changes (branch ${wt.branch} removed).`);
    expect(git(repo, "branch", "--list", wt.branch)).toBe("");
  });

  test("outside a git repo: a ToolError the model can act on", () => {
    expect(() => createWorktree({ root: trees, baseDir: trees, description: "x" })).toThrow(new ToolError(NOT_A_REPO));
  });
});
