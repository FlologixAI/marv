import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { sandboxArgs, sandboxAvailable } from "../sandbox.ts";
import type { Tool } from "./types.ts";

const DEFAULT_TIMEOUT_S = 120;
const isInside = (outer: string, inner: string) => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * How a command that runs without asking is kept away from the project's .git: read-only if it's there, an
 * empty read-only placeholder if it isn't (so it can't create one). bwrap can't mount on a symlink, so for a .git
 * that is one, the same goes for what it points to, when that's inside the project; outside it, the sandbox
 * already shows it read-only (or hides it, in the home folder).
 */
function gitGuard(root: string): { readOnly?: string[]; placeholders?: string[] } {
  const gitDir = join(root, ".git");
  let isLink: boolean;
  try {
    isLink = lstatSync(gitDir).isSymbolicLink();
  } catch {
    return { placeholders: [gitDir] };
  }
  if (!isLink) return { readOnly: [gitDir] };
  const target = resolve(dirname(gitDir), readlinkSync(gitDir));
  const realRoot = realpathSync(root);
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    // It leads nowhere yet: inside the project, keep that spot empty too.
    return isInside(realRoot, target) || isInside(root, target) ? { placeholders: [target] } : {};
  }
  return isInside(realRoot, real) ? { readOnly: [real] } : {};
}
/** Appended when a confined command fails on the read-only .git, so the model learns how to do it. */
const GIT_HINT = "Marv: .git is read-only for commands that run without asking. To change the repository, run the command again with git_write: true (the user is asked).";
const MAX_TIMEOUT_S = 600;
/** Kept in memory per command; anything beyond is dropped (the middle is cut for the model anyway). */
const MAX_CAPTURE = 2_000_000;
/** What the model sees: the start and the end of long output. */
const MAX_MODEL_CHARS = 30_000;
const HEAD_CHARS = 10_000;

export interface CommandResult {
  output: string;
  /** null when the command was killed. */
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs?: number;
}

interface RunOptions {
  command: string;
  root: string;
  sandbox: boolean;
  network: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  readOnly?: string[];
  placeholders?: string[];
  /** The home folder the sandbox hides (default: the user's); tests pass a fake one. */
  home?: string;
}

const hasSetsid = Bun.which("setsid") !== null;

/**
 * Runs a shell command in the project folder with stdout and stderr combined.
 * Sandboxed: inside bwrap (see src/sandbox.ts). Not sandboxed: still with a
 * minimal environment, so API keys don't leak into commands.
 */
export async function runCommand({ command, root, sandbox, network, timeoutMs, signal, readOnly, placeholders, home = homedir() }: RunOptions): Promise<CommandResult> {
  const path = process.env.PATH ?? "/usr/bin:/bin";
  const script = `exec 2>&1\n${command}`; // stderr into stdout, so the output stays in order
  const argv = sandbox
    ? ["bwrap", ...sandboxArgs({ root, home, network, path, readOnly, placeholders }), "--", "bash", "-c", script]
    : // setsid: its own process group, so killing it also kills everything it started.
      [...(hasSetsid ? ["setsid"] : []), "bash", "-c", script];

  const proc = Bun.spawn(argv, {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    // The command's own stderr goes to stdout (`exec 2>&1`), so only what comes before it lands here:
    // bwrap's own errors, e.g. when it can't set the sandbox up.
    stderr: "pipe",
    env: sandbox ? { PATH: path } : { PATH: path, HOME: home, LANG: process.env.LANG ?? "C.UTF-8", TERM: "dumb" },
  });

  let timedOut = false;
  let aborted = false;
  const kill = () => {
    try {
      if (!sandbox && hasSetsid) process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL"); // bwrap takes its whole sandbox down with it
    } catch {
      // already gone
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    kill();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  // Both at once, so neither pipe fills up and blocks the other.
  let [output, errors] = await Promise.all([capture(proc.stdout), capture(proc.stderr)]);
  await proc.exited;
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  const exitCode = timedOut || aborted ? null : proc.exitCode;
  // Without this, a sandbox that never started looks like a command that silently failed.
  if (sandbox && exitCode !== 0 && exitCode !== null && output.trim() === "" && errors.trim() !== "") {
    output = `[sandbox failed to start: ${errors.trim()}]\n`;
  }
  return { output, exitCode, timedOut, aborted, timeoutMs };
}

/** A stream's text, up to MAX_CAPTURE characters (the rest is read and dropped). */
async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    if (text.length < MAX_CAPTURE) text += decoder.decode(chunk, { stream: true });
  }
  return text;
}

/** The command's result as the model sees it: output (start and end if long), then how it ended. */
export function formatOutput({ output, exitCode, timedOut, aborted, timeoutMs }: CommandResult): string {
  let text = output.trim() === "" ? "(no output)" : output.trimEnd();
  if (text.length > MAX_MODEL_CHARS) {
    const tail = MAX_MODEL_CHARS - HEAD_CHARS;
    text = `${text.slice(0, HEAD_CHARS)}\n\n… (${text.length - MAX_MODEL_CHARS} characters omitted) …\n\n${text.slice(-tail)}`;
  }
  const ending = timedOut
    ? `[timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s]`
    : aborted
      ? "[stopped by the user]"
      : `[exit code ${exitCode}]`;
  return `${text}\n\n${ending}`;
}

const input = z.object({
  command: z.string().min(1).describe("The shell command (bash). Runs in the project folder."),
  timeout: z.number().int().min(1).max(MAX_TIMEOUT_S).optional().describe(`Seconds before it's stopped. Default ${DEFAULT_TIMEOUT_S}.`),
  network: z.boolean().optional().describe("Allow network access (e.g. to install packages). Off by default."),
  git_write: z
    .boolean()
    .optional()
    .describe("Set when the command changes the git repository (commit, checkout, merge, rebase, stash, branch, tag, init…). Otherwise .git may be read-only."),
});

export const bash: Tool<typeof input> = {
  name: "bash",
  description:
    "Run a shell command in the project folder, e.g. to run tests, a build, git status, or wc -l. " +
    "It runs in a sandbox: only the project folder is writable, the home folder is hidden, " +
    "and there's no network unless you set network: true. The user may be asked to approve a command; they always are for network: true or git_write: true. " +
    "Not interactive: commands can't prompt for input. " +
    "Output (stdout and stderr together) is cut in the middle if very long.",
  input,
  kind: "execute",
  label: ({ command }) => command,
  scope: ({ command, network, git_write }) => ({ key: `bash:${network ? "net:" : ""}${git_write ? "git:" : ""}${command}`, description: "this exact command" }),
  usesNetwork: ({ network }) => Boolean(network),
  // In the sandbox, without network, and (as runTool confines it) with .git read-only, a command can only change the
  // project's own files. Without the sandbox, nothing limits it.
  autoSafe: ({ network, git_write }, { sandbox = true }) => sandbox && sandboxAvailable() && !network && !git_write,

  async preview({ command, network, timeout }, { sandbox = true }) {
    const sandboxed = sandbox && sandboxAvailable();
    const notes = [sandboxed && "sandboxed", sandboxed && (network ? "network allowed" : "no network"), timeout && `timeout ${timeout}s`];
    return {
      title: "Run a command",
      command,
      note: notes.filter(Boolean).join(" · ") || undefined,
      warning: sandboxed
        ? undefined
        : sandbox
          ? "bubblewrap isn't available here, so this runs WITHOUT a sandbox"
          : "the sandbox is off (/sandbox on to turn it back on), so this runs WITHOUT a sandbox",
    };
  },

  async run({ command, network = false, timeout = DEFAULT_TIMEOUT_S }, { root, signal, sandbox = true, readOnly = [], confined }) {
    // A command that runs without asking sees .git read-only: git runs hooks and config from it outside any sandbox
    // (the user's next commit, their editor), so a planted hook would escape. Without a .git, it can't create one
    // either (an empty read-only placeholder sits there), or `git status` in that folder would run its config.
    const guard = confined ? gitGuard(root) : {};
    let result: CommandResult;
    try {
      result = await runCommand({
        command,
        root,
        sandbox: sandbox && sandboxAvailable(),
        network,
        timeoutMs: timeout * 1000,
        signal,
        readOnly: [...readOnly, ...(guard.readOnly ?? [])],
        placeholders: guard.placeholders,
      });
    } finally {
      // bwrap leaves a placeholder's empty mount point; rmdir only removes it while it's empty.
      for (const path of guard.placeholders ?? []) await rmdir(path).catch(() => {});
    }
    if (confined && /\.git\b.*Read-only file system/.test(result.output)) result.output += `\n${GIT_HINT}\n`;
    const lines = result.output.trimEnd() === "" ? 0 : result.output.trimEnd().split("\n").length;
    const summary = result.timedOut
      ? `timed out after ${timeout}s`
      : result.aborted
        ? "stopped"
        : `exit ${result.exitCode}${lines ? ` · ${lines} line${lines === 1 ? "" : "s"} of output` : ""}`;
    return { output: formatOutput(result), summary };
  },
};
