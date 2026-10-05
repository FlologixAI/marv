// The bash tool's sandbox, using bubblewrap (bwrap): the same Linux kernel
// features containers use (namespaces), without a container runtime.
//
// Inside it:
//   - the whole system is visible but read-only;
//   - the home folder is replaced by an empty one, so secrets there (~/.ssh,
//     ~/.marv with the API key, browser profiles, …) can't be read, except a
//     few toolchain folders (bun, cargo, git config…), mounted read-only, with
//     the credential files inside them hidden (tokens inside whole config
//     files, like ~/.gitconfig or ~/.cargo/config.toml, can't be);
//   - the project folder is the only writable place (plus a private /tmp); a
//     caller may add folders that are visible read-only, e.g. a worktree's .git;
//   - bun's download cache is a throwaway one in that private /tmp (RAM-backed),
//     gone when the command ends: a shared or host cache would let one sandboxed
//     command (e.g. an install's lifecycle scripts) plant packages for another
//     context;
//   - there's no network unless the command asked for it;
//   - the environment starts empty, so API keys can't leak into commands.
// Approval decides *whether* a command runs; the sandbox limits *what an
// approved command can touch*.
import { existsSync, lstatSync, realpathSync } from "node:fs";
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
  /**
   * Extra folders the command may read but not change, e.g. a worktree's shared .git (so git status/diff/log
   * work), or the worktree around a subagent that works in one of its subfolders (mounted under the project,
   * which stays writable).
   */
  readOnly?: string[];
  /** The file system, injectable for tests: whether a path exists (following symlinks), */
  exists?: (path: string) => boolean;
  /** what the path itself is (not following a final symlink), */
  stat?: (path: string) => "file" | "symlink" | null;
  /** and where it really leads (throws if it leads nowhere). */
  realpath?: (path: string) => string;
}

function lstatKind(path: string): "file" | "symlink" | null {
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

/**
 * The real path of an extra folder, after checking that mounting it is safe, and whether it holds the project
 * (it's then mounted before the project, so the project stays writable on top). bwrap follows symlinks, so the
 * check must too.
 */
function resolveExtra(dir: string, home: string, root: string): { real: string; around: boolean } {
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
  // Read-only over the project itself would leave nothing writable.
  if (real === realRoot) {
    throw new Error(`Refusing to make ${dir} read-only in the sandbox: it is the project folder.`);
  }
  return { real, around: contains(real, realRoot) };
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

/**
 * Credential files inside the toolchain folders above, replaced by an empty file: an approved (or
 * auto-approved) command could otherwise print them into the conversation, which goes to the model
 * provider. Tokens written into whole config files (~/.gitconfig, ~/.config/git/config,
 * ~/.cargo/config.toml) can't be hidden this way: the sandbox needs those files whole.
 */
const CREDENTIALS = [".cargo/credentials", ".cargo/credentials.toml", ".config/git/credentials"];

/**
 * Where to put /dev/null so the sandbox can't read a credential file, as paths inside the sandbox.
 * A plain file is masked where it is. bwrap can't mount on a symlink (and fails before the command
 * starts), so for a symlink (stow, chezmoi) the file it leads to is masked instead, wherever a
 * toolchain mount makes it visible; a link leading anywhere else already reads as missing, because
 * the home is hidden. Anything else is left alone.
 */
function credentialMasks(file: string, mounts: string[], stat: SandboxOptions["stat"] & {}, realpath: SandboxOptions["realpath"] & {}): string[] {
  const kind = stat(file);
  if (kind === "file") return [file];
  if (kind !== "symlink") return [];
  let target: string;
  try {
    target = realpath(file);
  } catch {
    return []; // dangling
  }
  if (stat(target) !== "file") return [];
  const masks: string[] = [];
  for (const mount of mounts) {
    let source: string;
    try {
      source = realpath(mount); // what bwrap mounted there
    } catch {
      continue;
    }
    // The real path has no symlinks below the mount point, so this is never a symlink inside the sandbox.
    if (contains(source, target)) masks.push(join(mount, relative(source, target)));
  }
  return masks;
}

/** bwrap's arguments (everything before `-- command`). Order matters: later mounts sit on top of earlier ones. */
export function sandboxArgs({
  root,
  home,
  network,
  path,
  readOnly = [],
  exists = existsSync,
  stat = lstatKind,
  realpath = realpathSync,
}: SandboxOptions): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", home];
  const mounts = TOOLCHAINS.map((dir) => join(home, dir)).filter((full) => exists(full));
  for (const full of mounts) args.push("--ro-bind", full, full);
  // Bind the resolved path (what was checked), at the path the caller gave. A folder around the project goes
  // first: mounted after it, it would cover the project and silently turn it read-only.
  const extras = readOnly.map((dir) => ({ dir, ...resolveExtra(dir, home, root) }));
  for (const { dir, real } of extras.filter((e) => e.around)) args.push("--ro-bind", real, dir);
  args.push("--bind", root, root);
  for (const { dir, real } of extras.filter((e) => !e.around)) args.push("--ro-bind", real, dir);
  // Last, on top of every other mount, so the empty file hides the real one and no later mount shows it again.
  const masks = new Set(CREDENTIALS.flatMap((file) => credentialMasks(join(home, file), mounts, stat, realpath)));
  for (const mask of masks) args.push("--ro-bind", "/dev/null", mask);
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
    // `bun install` needs a writable cache (it stages downloads inside it and fails at once if it can't).
    // Not the user's ~/.bun/install/cache, nor any cache that outlives the command: an install runs the
    // project's scripts, which could plant packages there for the user's own projects or another
    // sandbox. Packages land in the project's node_modules, which stays. (The private /tmp is a tmpfs,
    // so the cache takes RAM while the command runs.)
    "--setenv", "BUN_INSTALL_CACHE_DIR", "/tmp/bun-cache",
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
