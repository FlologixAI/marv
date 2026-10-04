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
import { existsSync, realpathSync } from "node:fs";
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

/** The real path of an extra folder, after checking that mounting it is safe. bwrap follows symlinks, so the check must too. */
function resolveExtra(dir: string, home: string, root: string): string {
  if (!isAbsolute(dir)) throw new Error(`Extra sandbox folder ${dir} must be an absolute path.`);
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new Error(`Extra sandbox folder ${dir} doesn't exist.`);
  }
  const realHome = realOrSelf(home);
  const realRoot = realOrSelf(root);
  // Mounting the home folder or a parent of it (even read-only) would expose the hidden home, with the API key in it.
  if (real === "/" || contains(real, realHome)) {
    throw new Error(`Refusing to make ${dir} visible in the sandbox: it is, or leads to, the home folder or one of its parents.`);
  }
  // Mounted after the root bind, the project itself would silently turn read-only.
  if (contains(real, realRoot)) {
    throw new Error(`Refusing to make ${dir} visible in the sandbox: it is the project folder or one of its parents.`);
  }
  return real;
}

/** Whether `outer` is `inner` or a parent of it. */
function contains(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
  // Bind the resolved path (what was checked), at the path the caller gave.
  for (const dir of readOnly) args.push("--ro-bind", resolveExtra(dir, home, root), dir);
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
