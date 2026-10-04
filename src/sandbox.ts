// The bash tool's sandbox, using bubblewrap (bwrap): the same Linux kernel
// features containers use (namespaces), without a container runtime.
//
// Inside it:
//   - the whole system is visible but read-only;
//   - the home folder is replaced by an empty one, so secrets there (~/.ssh,
//     ~/.marv with the API key, browser profiles, …) can't be read, except a
//     few toolchain folders (bun, cargo, git config…), mounted read-only;
//   - the project folder is the only writable place (plus a private /tmp); a
//     caller may add folders that are visible read-only, e.g. a worktree's .git;
//   - there's no network unless the command asked for it;
//   - the environment starts empty, so API keys can't leak into commands.
// Approval decides *whether* a command runs; the sandbox limits *what an
// approved command can touch*.
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** Folders from the hidden home folder a command may need, mounted read-only. */
const TOOLCHAINS = [
  ".bun",
  ".cargo",
  ".rustup",
  ".local/bin",
  ".local/share/pnpm",
  ".nvm",
  ".volta",
  ".deno",
  ".pyenv",
  ".gitconfig",
  ".config/git",
  // Personal skills, so their scripts can run (the rest of ~/.marv, with the API key, stays hidden).
  ".marv/skills",
];

interface SandboxOptions {
  root: string;
  home: string;
  network: boolean;
  /** PATH inside the sandbox. */
  path: string;
  /** Extra folders the command may read but not change, e.g. a worktree's shared .git (so git status/diff/log work). */
  readOnly?: string[];
  exists?: (path: string) => boolean;
}

function checkExtra(dir: string, home: string): void {
  // Mounting these, even read-only, would expose the hidden home folder (and the API key in it).
  const rel = relative(dir, home);
  if (!isAbsolute(dir) || dir === "/" || rel === "" || !rel.startsWith("..")) {
    throw new Error(`Refusing to make ${dir} visible in the sandbox: it must be an absolute path that is not the home folder or one of its parents.`);
  }
}

/** bwrap's arguments (everything before `-- command`). Order matters: later mounts sit on top of earlier ones. */
export function sandboxArgs({ root, home, network, path, readOnly = [], exists = existsSync }: SandboxOptions): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", home];
  for (const dir of TOOLCHAINS) {
    const full = join(home, dir);
    if (exists(full)) args.push("--ro-bind", full, full);
  }
  args.push("--bind", root, root);
  for (const dir of readOnly) {
    checkExtra(dir, home);
    args.push("--ro-bind", dir, dir); // not -try: a missing path should fail loudly
  }
  if (!network) args.push("--unshare-net");
  args.push(
    "--unshare-pid", // its processes can't see or signal ours, and all die with it
    "--die-with-parent",
    "--new-session", // can't inject keystrokes into our terminal
    "--clearenv",
    "--setenv", "PATH", path,
    "--setenv", "HOME", home,
    "--setenv", "LANG", process.env.LANG ?? "C.UTF-8",
    "--setenv", "TERM", "dumb",
    "--setenv", "TMPDIR", "/tmp",
    "--chdir", root,
  );
  return args;
}

let available: boolean | undefined;

/** Whether bwrap is installed and allowed to create namespaces here (checked once). */
export function sandboxAvailable(): boolean {
  if (available === undefined) {
    try {
      available = Bun.spawnSync(["bwrap", "--ro-bind", "/", "/", "--unshare-net", "--unshare-pid", "--", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
      available = false;
    }
  }
  return available;
}
