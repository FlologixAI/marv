# Post-edit diagnostics (TypeScript)

Issues: #11 (parent), #12 (eval tasks), #13 (the check). Milestone 0.2.0.

## Problem

After `edit_file`/`write_file`, Marv checks that the file still parses (`src/tools/syntax.ts`). In the evals that check fixed 4 of 4 broken edits. It can't catch code that parses but is wrong: a renamed export still used in another file, a missing required field, a caller reading a property off a `Promise`. A typechecker catches those, and models often don't run one: in a third of eval runs the model ran nothing after its last edit.

## Decisions

- **The project's own checker, run by Marv** (not a language server, not left to the model). A language server is several times the machinery (lifecycle, file sync, one per language) and would still have to be sandboxed.
- **TypeScript only in v1, auto-detected.** It's the stack the new eval tasks measure. Python and others come once this has shown it helps.
- **New errors anywhere in the project**, compared with a baseline, not all errors in the changed files. The most useful errors are often in files the model didn't touch (the callers of something it renamed), and errors already in a messy repo must never be blamed on it.
- **Once per step, not per edit.** A step that edits 4 files runs one check.

## How it works

### Detection

`detectChecker(root)` returns a checker when `root/tsconfig.json` exists and `root/node_modules/.bin/tsgo` or `root/node_modules/.bin/tsc` exists (`tsgo` first). Otherwise null, and nothing else in this spec happens: no cost for projects without TypeScript.

Command: `<bin> --noEmit --pretty false --incremental false -p tsconfig.json`. `--incremental false` because the project is mounted read-only and a tsconfig with `incremental: true` would otherwise try to write `.tsbuildinfo`.

Speed: Marv itself (24k lines, TypeScript 7, the native compiler) checks in 0.5 s. TypeScript 5.x is around 10× slower.

### Errors and comparison

`tsc --pretty false` prints `path(line,col): error TSnnnn: message`, with longer messages continuing on indented lines, and errors with no file as `error TSnnnn: message`. Each error is parsed into `{ file?, line?, column?, code, message }`, its continuation lines joined into the message.

`newErrors(baseline, now)` compares by **file + code + message**, ignoring line and column, since edits shift lines. It treats errors as counts, not a set: the same error twice in a file with one in the baseline gives one new error.

### Per turn

1. **Baseline.** `ToolContext.beforeChange()` is memoized per turn. `edit_file` and `write_file` call it without waiting in `preview()`, so the check usually runs while the user reads the approval prompt, and wait for it in `run()` before writing. That keeps the baseline correct in yolo mode, where the write follows the preview at once. A new baseline is taken each turn, so the user's own edits between turns are never blamed on the model.
2. **End of step.** `runAgent` gets an optional `afterStep(changed)` hook, called after all of the step's tool results are in the history. The session supplies it and knows which calls changed a file (a result with a `diff`). If none did, nothing runs.
3. **Report.** If there are new errors, the hook returns a note, which `runAgent` appends as a user message from Marv, like `CUT_OFF_NOTE`:

   ```
   Marv: the typecheck after your changes found 2 new errors:
   src/cli.tsx:41:7 TS2304 Cannot find name 'loadConfig'.
   src/app.tsx:88:3 TS2345 Argument of type 'string' is not assignable to …
   ```

   At most 20 errors, then `and N more`. The current result becomes the baseline, so each error is reported once. With no new errors nothing is appended (zero tokens). The history is only appended to, so the prompt cache holds.

`runAgent` stays free of TypeScript knowledge: it only calls the hook and emits a `check` loop event (`{ errors, new, ms }`) for the UI and trajectories.

### v1 scope

The main agent only. Parallel shared-folder subagents editing at once would make it unclear whose step broke what, and worktree subagents have no `node_modules`. Edits made through `bash` (`sed`, a codemod) don't trigger a check, but the next edit's check sees their errors (they're the model's own). Solution-style tsconfigs (`"files": []` plus `references`, meant for `tsc -b`) check nothing with `-p`: a known limit.

## Safety

`node_modules/.bin/tsc` is the project's code: a cloned repo, or an earlier `bun install`, can put anything there, and Marv runs it unasked. So the check:

- always runs **in the sandbox** (no network, a cleared environment, the hidden home folder);
- sees the **project read-only**: a new `projectReadOnly` option in `sandboxArgs` binds the project with `--ro-bind` instead of `--bind`, so a planted `tsc` can read but change nothing. That is why it runs without approval even with yolo off;
- doesn't run at all when the sandbox can't (`/sandbox off`, or no bwrap). The first time, Marv shows "diagnostics need the sandbox". Running project code outside the sandbox unasked is what the MCP trust check and `runGit` exist to prevent.

## Failures

The agent is never blocked by the check.

- **Timeout:** 60 s per check. If the baseline times out, that turn has no check. Two timeouts in a session turn checks off for the session, and Marv says so once.
- **Esc/ctrl+c** kills a running check along with the turn. Every tool call already has its result by then.
- **Unparsable output** (tsc crashed, nonzero exit with no error lines) counts as unavailable for that turn: no report, and no more checks until the next turn (a step check that times out too). Errors added meanwhile end up in the next turn's baseline and aren't reported: the price of not rerunning a failing compiler on every step. Errors with no file (`TS5023` config errors) are compared like any other, so one already in the baseline isn't reported.

## UI, settings, records

- While a step-end check runs, the waiting line says **"Checking types…"** with its timer: a new session `status` (`checking`), like `compacting`.
- New errors add a dim transcript entry, **`Typecheck: N new errors`**, with the same list the model got, collapsed (ctrl+o expands, like diffs). Nothing new: nothing shown.
- Config `diagnostics` (on by default) and `/diagnostics on|off`, like `/trajectories`. The SDK takes `diagnostics?: boolean`, on by default. Read when a turn starts, like the other settings.
- Trajectories get a `check` record: ms, errors before and after, how many were new.

## Testing

- `tests/diagnostics.test.ts`: parsing (continuation lines, errors with no file), `newErrors` (counts, shifted lines aren't new), detection (`tsconfig` plus `tsc`, `tsgo`, neither).
- Sandbox: `projectReadOnly` produces `--ro-bind` for the project; with bwrap available, a write inside fails.
- `tests/agent.test.ts`: `afterStep` runs only when a step changed a file; the note comes after all of the step's tool results; the "every request extends the previous one" check still passes; Esc during a check ends cleanly with every call answered.
- Session, with a fake checker: the baseline finishes before the first write, in yolo too; a new baseline each turn; the second timeout turns checks off; no sandbox → no check, notice shown once.
- End to end (bwrap only): a temp project with `tsconfig.json` and a copy of Marv's `typescript`; a `ScriptedProvider` renames an export, and the note names the broken caller in another file.
- UI: the "Checking types…" line and the collapsed entry.

## Measuring (#12, before the check is built)

Three TypeScript eval tasks where a change parses but breaks types:

1. `ts-rename-export`: rename an exported function used in 3 files, one through a re-export in `index.ts`.
2. `ts-required-field`: add a required field to an interface; the object literals that need it are in several files, and searching for the interface's name doesn't find them all.
3. `ts-make-async`: make a function `async`; its callers then read a property off a `Promise`.

Each `check/` runs `tsc --noEmit` and the task's tests. `evals/run.ts` copies Marv's own `typescript` package (about 30 MB with the native binary) into each temp repo's `node_modules`, git-ignored so the diff stays clean. A symlink wouldn't work: it points into the home folder the sandbox hides. `bun run eval --verify` must pass for all three.

A baseline run of current Marv is recorded first. Once the check lands: same models, same day, `diagnostics` on vs off, 3 repetitions each. Compare the pass rate and steps on the TS tasks, and confirm the 10 JS tasks are unchanged (no `tsconfig`, no checker). If it doesn't help on the TS tasks, it doesn't ship.
