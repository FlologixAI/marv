// Marv's own git calls (worktrees, the file listing behind glob and grep) run
// outside the sandbox, without approval, in folders an agent could have
// tampered with. So they never run a repository's programs (hooks, fsmonitor),
// never wait for input, and never wait forever (`spawnSync` blocks the whole
// UI, ctrl+c included, until git exits).

/** Hooks and fsmonitor are how a repository makes git run a program; Marv's own git calls turn both off. */
export const NO_PROGRAMS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

/** The environment without inherited GIT_* variables (a parent git or hook could have set GIT_DIR, GIT_INDEX_FILE…), plus `pinned`. */
export function gitEnvironment(pinned: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  return { ...env, ...pinned };
}

export const GIT_TIMEOUT_MS = 60_000;

export interface GitResult {
  ok: boolean;
  /** stdout when it succeeded, stderr when it failed; not trimmed. */
  out: string;
  timedOut: boolean;
}

export function runGit(
  cwd: string,
  args: string[],
  { env, timeoutMs = GIT_TIMEOUT_MS }: { env?: Record<string, string>; timeoutMs?: number } = {},
): GitResult {
  const result = Bun.spawnSync(["git", ...NO_PROGRAMS, ...args], {
    cwd,
    env: gitEnvironment(env),
    stdin: "ignore", // nothing may wait for input: there's no one to type it
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  if (result.exitedDueToTimeout) return { ok: false, out: "", timedOut: true };
  const ok = result.exitCode === 0;
  return { ok, out: (ok ? result.stdout : result.stderr).toString(), timedOut: false };
}
