import { homedir } from "node:os";
import { z } from "zod";
import { sandboxArgs, sandboxAvailable } from "../sandbox.ts";
import type { Tool } from "./types.ts";

const DEFAULT_TIMEOUT_S = 120;
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
  /** The home folder the sandbox hides (default: the user's); tests pass a fake one. */
  home?: string;
}

const hasSetsid = Bun.which("setsid") !== null;

/**
 * Runs a shell command in the project folder with stdout and stderr combined.
 * Sandboxed: inside bwrap (see src/sandbox.ts). Not sandboxed: still with a
 * minimal environment, so API keys don't leak into commands.
 */
export async function runCommand({ command, root, sandbox, network, timeoutMs, signal, readOnly, home = homedir() }: RunOptions): Promise<CommandResult> {
  const path = process.env.PATH ?? "/usr/bin:/bin";
  const script = `exec 2>&1\n${command}`; // stderr into stdout, so the output stays in order
  const argv = sandbox
    ? ["bwrap", ...sandboxArgs({ root, home, network, path, readOnly }), "--", "bash", "-c", script]
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
});

export const bash: Tool<typeof input> = {
  name: "bash",
  description:
    "Run a shell command in the project folder, e.g. to run tests, a build, git status, or wc -l. " +
    "The user approves each command. It runs in a sandbox: only the project folder is writable, the home folder is hidden, " +
    "and there's no network unless you set network: true. Not interactive: commands can't prompt for input. " +
    "Output (stdout and stderr together) is cut in the middle if very long.",
  input,
  kind: "execute",
  label: ({ command }) => command,
  scope: ({ command, network }) => ({ key: `bash:${network ? "net:" : ""}${command}`, description: "this exact command" }),
  usesNetwork: ({ network }) => Boolean(network),

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

  async run({ command, network = false, timeout = DEFAULT_TIMEOUT_S }, { root, signal, sandbox = true, readOnly }) {
    const result = await runCommand({ command, root, sandbox: sandbox && sandboxAvailable(), network, timeoutMs: timeout * 1000, signal, readOnly });
    const lines = result.output.trimEnd() === "" ? 0 : result.output.trimEnd().split("\n").length;
    const summary = result.timedOut
      ? `timed out after ${timeout}s`
      : result.aborted
        ? "stopped"
        : `exit ${result.exitCode}${lines ? ` · ${lines} line${lines === 1 ? "" : "s"} of output` : ""}`;
    return { output: formatOutput(result), summary };
  },
};
