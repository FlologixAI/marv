// The open question from the subagents design, answered with the real bwrap: in a worktree, can a
// sandboxed command install dependencies, run the tests and read git, while the repository itself
// (the shared .git, shown read-only) stays unchangeable?
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxAvailable } from "../src/sandbox.ts";
import { runCommand } from "../src/tools/bash.ts";
import { createWorktree, finishWorktree, type Worktree } from "../src/worktree.ts";

// The real sandbox, so only where bubblewrap works.
const sandboxed = sandboxAvailable() ? test : test.skip;
// Installing a real package needs the network: opt in with MARV_NETWORK_TESTS=1.
const online = sandboxAvailable() && process.env.MARV_NETWORK_TESTS === "1" ? test : test.skip;

let repo: string;
let trees: string;
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "marv-wts-repo-"));
  trees = await mkdtemp(join(tmpdir(), "marv-wts-trees-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "demo", private: true }));
  await writeFile(join(repo, "sum.test.ts"), 'import { expect, test } from "bun:test";\ntest("sum", () => expect(1 + 1).toBe(2));\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(trees, { recursive: true, force: true });
});

// How a worktree subagent's bash runs: the worktree writable, the shared .git read-only.
const inWorktree = (wt: Worktree, command: string, network = false) =>
  runCommand({ command, root: wt.dir, sandbox: true, network, timeoutMs: 120_000, readOnly: [wt.gitDir] });

sandboxed("builds, tests and reads git inside the sandbox; Marv commits afterwards", async () => {
  const wt = createWorktree({ root: repo, baseDir: trees, description: "sandbox check" });
  const result = await inWorktree(wt, "bun install && bun test && echo hi > hi.txt && git status --porcelain && git log --oneline -1");
  expect(result.output).toContain("1 pass");
  expect(result.output).toContain("?? hi.txt");
  expect(result.output).toContain("first");
  expect(result.exitCode).toBe(0);
  expect(finishWorktree(wt, { description: "sandbox check", interrupted: false })).toContain("1 commit");
  expect(git(repo, "show", `${wt.branch}:hi.txt`)).toBe("hi");
}, 130_000);

sandboxed("inside the sandbox, the repository can't be changed", async () => {
  const wt = createWorktree({ root: repo, baseDir: trees, description: "escape check" });
  const config = await readFile(join(wt.gitDir, "config"), "utf8");
  const commondir = await readFile(join(wt.adminDir, "commondir"), "utf8");
  const refs = git(repo, "for-each-ref");

  for (const command of [
    "touch x && git add x", // the index lives in .git/worktrees/<id>
    // A hook git would run outside the sandbox (fails at the mkdir if there's no hooks folder yet, at the write if there is).
    `mkdir -p ${join(wt.gitDir, "hooks")} && echo 'touch /tmp/x' > ${join(wt.gitDir, "hooks", "pre-commit")}`,
    "git config core.fsmonitor 'touch /tmp/x'", // config that runs a program
    `echo /elsewhere > ${join(wt.adminDir, "commondir")}`, // repointing the worktree's record
    "git branch other", // a new ref
    "git update-ref refs/heads/main HEAD", // moving a branch (bypasses the checked-out-branch check)
    // The user's own bun cache (only where it exists: elsewhere the sandbox's home is an empty, throwaway tmpfs).
    ...(existsSync(join(homedir(), ".bun", "install", "cache")) ? ["touch ~/.bun/install/cache/planted"] : []),
  ]) {
    const result = await inWorktree(wt, command);
    // Each must fail because the repository is read-only, not for some other reason.
    // (The command is in the compared object so a failure says which one.)
    expect({ command, failed: result.exitCode !== 0, output: result.output }).toMatchObject({
      command,
      failed: true,
      output: expect.stringContaining("Read-only file system"),
    });
  }

  // And nothing in the repository changed.
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(existsSync(join(wt.gitDir, "hooks", "pre-commit"))).toBe(false);
  expect(await readFile(join(wt.gitDir, "config"), "utf8")).toBe(config);
  expect(await readFile(join(wt.adminDir, "commondir"), "utf8")).toBe(commondir);
  expect(git(repo, "for-each-ref")).toBe(refs);
  finishWorktree(wt, { description: "escape check", interrupted: false });
}, 130_000);

sandboxed("Marv's own folder stays hidden: only personal skills are visible", async () => {
  const wt = createWorktree({ root: repo, baseDir: trees, description: "home check" });
  const listing = await inWorktree(wt, "ls -A ~/.marv");
  const skills = existsSync(join(homedir(), ".marv", "skills"));
  if (skills) expect(listing.output.trim()).toBe("skills");
  else expect(listing.exitCode).not.toBe(0); // no ~/.marv at all
  const config = await inWorktree(wt, "cat ~/.marv/config.json");
  expect(config.exitCode).not.toBe(0);
  expect(config.output).toContain("No such file or directory");
  finishWorktree(wt, { description: "home check", interrupted: false });
}, 130_000);

online("installs a real dependency inside the sandbox", async () => {
  const wt = createWorktree({ root: repo, baseDir: trees, description: "deps check" });
  await writeFile(join(wt.dir, "package.json"), JSON.stringify({ name: "demo", private: true, dependencies: { "is-number": "7.0.0" } }));
  const run = "bun install && bun -e 'console.log(require(\"is-number\")(5))'";
  const result = await inWorktree(wt, run, true);
  expect(result.output).toContain("true");
  expect(result.exitCode).toBe(0);
  // bun's cache was thrown away with the command, but the packages are in the worktree's node_modules,
  // so later commands use them without the network (and without reinstalling).
  await writeFile(join(wt.dir, "dep.test.ts"), 'import { expect, test } from "bun:test";\nimport isNumber from "is-number";\ntest("dep", () => expect(isNumber(5)).toBe(true));\n');
  const offline = await inWorktree(wt, "ls /tmp; bun test dep.test.ts && bun -e 'console.log(require(\"is-number\")(5))'");
  expect(offline.output).not.toContain("bun-cache");
  expect(offline.output).toContain("1 pass");
  expect(offline.output).toContain("true");
  expect(offline.exitCode).toBe(0);
  finishWorktree(wt, { description: "deps check", interrupted: false });
}, 130_000);
