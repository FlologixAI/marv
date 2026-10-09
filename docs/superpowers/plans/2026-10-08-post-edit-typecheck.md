# Post-Edit Typecheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue #13. After a step that changed files in a TypeScript project, Marv runs the project's own `tsc` in the sandbox (project read-only) and tells the model only the errors that are new since the turn's baseline.

**Architecture:** There are two new modules. `src/diagnostics/tsc.ts` is pure: it detects the compiler, parses its output, compares errors with a baseline, and formats the note. `src/diagnostics/turn.ts` holds the per-session state (timeouts, notices) and builds each turn's `beforeChange`/`afterStep` closures. The session hands those to the tools through `ToolContext.beforeChange` (the edit tools take the baseline before writing) and to `runAgent` as its `afterStep` hook. That hook appends the note as a user message from Marv after the step's tool results. `runAgent` stays free of TypeScript knowledge. The UI, SDK, config, trajectories and evals each get a small, separate change.

**Tech Stack:** Bun, TypeScript 7 (`node_modules/.bin/tsc`), bubblewrap via `runCommand` (`src/tools/bash.ts`), `bun:test`, Ink (App).

Spec: `docs/superpowers/specs/2026-10-08-post-edit-diagnostics-design.md`. Branch: `post-edit-diagnostics`. #12 already added the TypeScript eval tasks and the baseline (`ts-baseline`, `ts-baseline-50`, see the comments on #12).

**One deliberate simplification of the spec:** the transcript entry is a `✻` system notice showing the first 5 new errors, then "… and N more". The spec asked for a collapsible list that ctrl+o expands. The model always gets up to 20 errors.

**Background for the engineer:**
- Read `CLAUDE.md` first, especially these sections: **Agent loop**, **Session**, **Tools**, **Sandbox**, **Prompt cache (don't break it)**.
- **Conventions:** imports use explicit `.ts`/`.tsx` extensions, and `import type` for types. Comments explain *why*. Test helpers are in `tests/fake-provider.ts` (`ScriptedProvider` replays scripted model replies and records every request).
- **The history is append-only (prompt cache).** The note is *appended* as `{ role: "user", text }` after the step's tool messages, exactly like `CUT_OFF_NOTE` in `src/agent.ts`.
- **The compiler is project code.** A cloned repository can plant anything in `node_modules/.bin/tsc`, so it only ever runs sandboxed with the project mounted read-only. With no sandbox, it doesn't run at all.
- **Commands:** `bun test <path substring>`, `bun test -t "<name>"`, `bun run typecheck`, `bun test` (the whole suite, about 1025 tests, about 20 s).

---

### Task 1: Read tsc's output (`src/diagnostics/tsc.ts`)

**Files:**
- Create: `src/diagnostics/tsc.ts`
- Test: `tests/diagnostics-tsc.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/diagnostics-tsc.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand, detectChecker, diagnosticsNote, formatError, MAX_REPORTED, newErrors, parseTsc, type TsError } from "../src/diagnostics/tsc.ts";

describe("parseTsc", () => {
  test("located errors, errors about the configuration, and continuation lines", () => {
    const output = [
      "src/a.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
      "src/b.ts(3,1): error TS2322: Type '{ a: string; }' is not assignable to type 'T'.",
      "  Property 'b' is missing in type '{ a: string; }' but required in type 'T'.",
      "error TS5023: Unknown compiler option 'foo'.",
      "",
    ].join("\n");
    expect(parseTsc(output, 2)).toEqual([
      { file: "src/a.ts", line: 12, column: 5, code: "TS2345", message: "Argument of type 'string' is not assignable to parameter of type 'number'." },
      { file: "src/b.ts", line: 3, column: 1, code: "TS2322", message: "Type '{ a: string; }' is not assignable to type 'T'.\nProperty 'b' is missing in type '{ a: string; }' but required in type 'T'." },
      { code: "TS5023", message: "Unknown compiler option 'foo'." },
    ]);
  });

  test("exit code 0 is no errors, whatever was printed", () => {
    expect(parseTsc("", 0)).toEqual([]);
  });

  test("a failure that printed no errors can't be read (a crash, or not tsc at all): null", () => {
    expect(parseTsc("Segmentation fault\n", 139)).toBeNull();
    expect(parseTsc("", 1)).toBeNull();
    expect(parseTsc("", null)).toBeNull();
  });
});

describe("newErrors", () => {
  const e = (file: string, line: number, code: string, message: string): TsError => ({ file, line, column: 1, code, message });

  test("matched by file, code and message: an old error that moved isn't new", () => {
    const before = [e("a.ts", 3, "TS2304", "Cannot find name 'x'.")];
    const now = [e("a.ts", 9, "TS2304", "Cannot find name 'x'."), e("b.ts", 1, "TS2304", "Cannot find name 'y'.")];
    expect(newErrors(before, now)).toEqual([now[1]!]);
  });

  test("counts, not a set: a second copy of an old error is new", () => {
    const before = [e("a.ts", 3, "TS2304", "Cannot find name 'x'.")];
    const now = [e("a.ts", 3, "TS2304", "Cannot find name 'x'."), e("a.ts", 7, "TS2304", "Cannot find name 'x'.")];
    expect(newErrors(before, now)).toEqual([now[1]!]);
  });

  test("a fixed error isn't reported", () => {
    expect(newErrors([e("a.ts", 1, "TS2304", "x")], [])).toEqual([]);
  });
});

describe("the note", () => {
  test("one line per error, as file:line:column code message, continuation lines indented", () => {
    expect(formatError({ file: "src/a.ts", line: 4, column: 2, code: "TS2322", message: "Type 'A' is not assignable.\nProperty 'b' is missing." })).toBe(
      "src/a.ts:4:2 TS2322 Type 'A' is not assignable.\n  Property 'b' is missing.",
    );
    expect(formatError({ code: "TS5023", message: "Unknown compiler option 'foo'." })).toBe("TS5023 Unknown compiler option 'foo'.");
  });

  test("starts with Marv: and says how many; shows at most MAX_REPORTED and counts the rest", () => {
    const one = diagnosticsNote([{ file: "a.ts", line: 1, column: 1, code: "TS2304", message: "Cannot find name 'x'." }]);
    expect(one).toBe("Marv: the typecheck (tsc) after your changes found 1 new error:\na.ts:1:1 TS2304 Cannot find name 'x'.");
    const many = Array.from({ length: MAX_REPORTED + 3 }, (_, i): TsError => ({ file: "a.ts", line: i + 1, column: 1, code: "TS2304", message: `Cannot find name 'v${i}'.` }));
    const note = diagnosticsNote(many);
    expect(note.split("\n")[0]).toBe(`Marv: the typecheck (tsc) after your changes found ${MAX_REPORTED + 3} new errors:`);
    expect(note.split("\n")).toHaveLength(1 + MAX_REPORTED + 1);
    expect(note.split("\n").at(-1)).toBe("and 3 more.");
  });
});

describe("detectChecker", () => {
  let root: string;
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "marv-detect-"))));
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const bin = (name: string) => {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(root, "node_modules", ".bin", name), "");
  };

  test("a tsconfig.json and the project's own tsc", () => {
    writeFileSync(join(root, "tsconfig.json"), "{}");
    bin("tsc");
    expect(detectChecker(root)).toBe("node_modules/.bin/tsc");
  });

  test("tsgo (TypeScript's native preview) first", () => {
    writeFileSync(join(root, "tsconfig.json"), "{}");
    bin("tsc");
    bin("tsgo");
    expect(detectChecker(root)).toBe("node_modules/.bin/tsgo");
  });

  test("nothing without a tsconfig.json, or without a compiler in the project", () => {
    bin("tsc");
    expect(detectChecker(root)).toBeNull();
    rmSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), "{}");
    expect(detectChecker(root)).toBeNull();
  });

  test("the command: no output files, plain lines, no .tsbuildinfo", () => {
    expect(checkCommand("node_modules/.bin/tsc")).toBe("node_modules/.bin/tsc --noEmit --pretty false --incremental false -p tsconfig.json");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test tests/diagnostics-tsc`
Expected: FAIL, `Cannot find module '../src/diagnostics/tsc.ts'`.

- [ ] **Step 3: Write the module**

`src/diagnostics/tsc.ts`:

```ts
// Reading TypeScript's own checker, for the typecheck Marv runs after a step's file changes (./turn.ts). Pure: no
// processes, and no files beyond seeing whether the project has a compiler.
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface TsError {
  /** As tsc prints it (relative to the project); absent for errors about the configuration. */
  file?: string;
  line?: number;
  column?: number;
  /** "TS2345". */
  code: string;
  /** With its continuation lines (tsc's indented detail), joined by newlines. */
  message: string;
}

/** Errors the model is told per check; the rest are counted. */
export const MAX_REPORTED = 20;

/** The project's own compiler (tsgo first: TypeScript's native preview), or null when there's nothing to check with. */
export function detectChecker(root: string): string | null {
  if (!existsSync(join(root, "tsconfig.json"))) return null;
  for (const name of ["tsgo", "tsc"]) {
    const bin = join("node_modules", ".bin", name);
    if (existsSync(join(root, bin))) return bin;
  }
  return null;
}

/** No output files, one plain line per error, and no .tsbuildinfo: the project is mounted read-only. */
export const checkCommand = (bin: string) => `${bin} --noEmit --pretty false --incremental false -p tsconfig.json`;

const LOCATED = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const UNLOCATED = /^error (TS\d+): (.*)$/;

/**
 * The errors in tsc's `--pretty false` output. Null when a failed run printed none: a crash, or something else
 * answering to the name. Then nobody can tell what's new, and nothing is reported.
 */
export function parseTsc(output: string, exitCode: number | null): TsError[] | null {
  if (exitCode === 0) return [];
  const errors: TsError[] = [];
  for (const line of output.split("\n")) {
    const located = LOCATED.exec(line);
    const unlocated = located ? null : UNLOCATED.exec(line);
    if (located) errors.push({ file: located[1]!, line: Number(located[2]), column: Number(located[3]), code: located[4]!, message: located[5]! });
    else if (unlocated) errors.push({ code: unlocated[1]!, message: unlocated[2]! });
    else if (/^\s/.test(line) && line.trim() && errors.length) errors.at(-1)!.message += `\n${line.trim()}`;
  }
  return errors.length ? errors : null;
}

const key = (e: TsError) => `${e.file ?? ""}\u0000${e.code}\u0000${e.message}`;

/**
 * The errors in `now` that `before` didn't have. Matched by file, code and message, not line: edits move lines.
 * Counted, not a set, so a second copy of an old error is new.
 */
export function newErrors(before: TsError[], now: TsError[]): TsError[] {
  const left = new Map<string, number>();
  for (const e of before) left.set(key(e), (left.get(key(e)) ?? 0) + 1);
  return now.filter((e) => {
    const n = left.get(key(e)) ?? 0;
    if (n > 0) left.set(key(e), n - 1);
    return n === 0;
  });
}

/** `src/a.ts:4:2 TS2322 message`, continuation lines indented. */
export function formatError(e: TsError): string {
  const where = e.file ? `${e.file}:${e.line}:${e.column} ` : "";
  return `${where}${e.code} ${e.message.replaceAll("\n", "\n  ")}`;
}

/** What the model is told: a message from Marv, like the cut-off and empty-reply notes. */
export function diagnosticsNote(added: TsError[]): string {
  const shown = added.slice(0, MAX_REPORTED).map(formatError);
  const more = added.length - shown.length;
  return [
    `Marv: the typecheck (tsc) after your changes found ${added.length} new error${added.length === 1 ? "" : "s"}:`,
    ...shown,
    ...(more ? [`and ${more} more.`] : []),
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test tests/diagnostics-tsc`
Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/tsc.ts tests/diagnostics-tsc.test.ts
git commit -m "Diagnostics: read tsc's output and find the new errors, #13"
```

### Task 2: The sandbox can mount the project read-only

**Files:**
- Modify: `src/sandbox.ts` (`SandboxOptions`, `sandboxArgs`)
- Modify: `src/tools/bash.ts` (`RunOptions`, `runCommand`)
- Test: `tests/bash.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/bash.test.ts`, add `existsSync` to the `node:fs` import and `readFile` to the `node:fs/promises` import. Then add this test in `describe("sandboxArgs", …)`, right after the test `"read-only system, hidden home, writable project, no network, clean env"`:

```ts
  test("projectReadOnly mounts the project read-only (Marv's own checks run project code unasked)", () => {
    const args = sandboxArgs({ ...base, network: false, projectReadOnly: true }).join(" ");
    expect(args).toContain("--ro-bind /home/me/proj /home/me/proj");
    expect(args).not.toContain("--bind /home/me/proj /home/me/proj");
  });
```

In `describe.if(sandboxAvailable())("inside the bubblewrap sandbox", …)`, after its first test (`"can write the project, but not the system"`), add this. `root` is that block's per-test project folder, the one its other tests use:

```ts
    test("with projectReadOnly, the project can be read but not changed", async () => {
      await writeFile(join(root, "kept.txt"), "kept\n");
      const result = await runCommand({ command: "cat kept.txt; touch made-it; echo changed > kept.txt", root, sandbox: true, network: false, projectReadOnly: true, timeoutMs: 10_000 });
      expect(result.output).toContain("kept");
      expect(result.output).toContain("Read-only file system");
      expect(existsSync(join(root, "made-it"))).toBe(false);
      expect(await readFile(join(root, "kept.txt"), "utf8")).toBe("kept\n");
    });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test tests/bash`
Expected: the `projectReadOnly mounts…` test fails, and so does the in-sandbox one where bwrap works (`made-it` gets created). `bun run typecheck` also reports `projectReadOnly` as an unknown property.

- [ ] **Step 3: Implement**

In `src/sandbox.ts`, add to `SandboxOptions`, after `placeholders`:

```ts
  /** The project read-only too: for Marv's own checks, which run the project's code without asking (src/diagnostics). */
  projectReadOnly?: boolean;
```

In `sandboxArgs`, add `projectReadOnly = false,` to the destructured parameters (after `placeholders = [],`), and replace

```ts
  args.push("--bind", root, root);
```

with

```ts
  args.push(projectReadOnly ? "--ro-bind" : "--bind", root, root);
```

In `src/tools/bash.ts`, add to `RunOptions`, after `placeholders?: string[];`:

```ts
  /** Mount the project read-only (see SandboxOptions.projectReadOnly). */
  projectReadOnly?: boolean;
```

Then add `projectReadOnly` to `runCommand`'s destructured parameters (after `placeholders`), and pass it through: `sandboxArgs({ root, home, network, path, readOnly, placeholders, projectReadOnly })`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test tests/bash && bun run typecheck`
Expected: all pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/sandbox.ts src/tools/bash.ts tests/bash.test.ts
git commit -m "Sandbox: projectReadOnly, for checks that run project code unasked, #13"
```

### Task 3: A turn's checks (`src/diagnostics/turn.ts`)

**Files:**
- Create: `src/diagnostics/turn.ts`
- Test: `tests/diagnostics-turn.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/diagnostics-turn.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNotice, Diagnostics, type CheckResult, type RunCheck } from "../src/diagnostics/turn.ts";
import type { CommandResult } from "../src/tools/bash.ts";
import type { ToolResult } from "../src/tools/types.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "marv-checks-"));
  writeFileSync(join(root, "tsconfig.json"), "{}");
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".bin", "tsc"), "");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ok = (output = ""): CommandResult => ({ output, exitCode: 0, timedOut: false, aborted: false });
const failed = (output: string): CommandResult => ({ output, exitCode: 2, timedOut: false, aborted: false });
const ERR_X = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.\n";
const ERR_Y = "src/b.ts(2,3): error TS2304: Cannot find name 'y'.\n";
const changed: ToolResult[] = [{ output: "Edited a.ts", summary: "+1 −1", diff: { lines: [], more: 0 } }];
const unchanged: ToolResult[] = [{ output: "contents", summary: "1 line" }];

/** A stand-in for the sandboxed tsc: answers each run with the next result, and counts the runs. */
function fake(...answers: CommandResult[]): RunCheck & { runs: number } {
  const run = Object.assign(async () => (run.runs++, answers.shift() ?? ok()), { runs: 0 });
  return run;
}

function turn(diagnostics: Diagnostics, { sandbox = true } = {}) {
  const results: CheckResult[] = [];
  const statuses: boolean[] = [];
  const checks = diagnostics.turn({ root, sandbox, signal: new AbortController().signal, onStatus: (s) => statuses.push(s), onResult: (r) => results.push(r) });
  return { checks, results, statuses };
}

describe("a turn's checks", () => {
  test("the baseline is taken once, however many changes ask for it", async () => {
    const run = fake(ok());
    const { checks } = turn(new Diagnostics({ run, sandboxWorks: () => true }));
    await Promise.all([checks.beforeChange(), checks.beforeChange()]);
    await checks.beforeChange();
    expect(run.runs).toBe(1);
  });

  test("after a step that changed a file, only the errors the step added are told, and they become the next baseline", async () => {
    const run = fake(failed(ERR_X), failed(ERR_X + ERR_Y), failed(ERR_X + ERR_Y));
    const { checks, results, statuses } = turn(new Diagnostics({ run, sandboxWorks: () => true }));
    await checks.beforeChange();
    const note = await checks.afterStep(changed);
    expect(note).toContain("found 1 new error");
    expect(note).toContain("src/b.ts:2:3 TS2304 Cannot find name 'y'.");
    expect(note).not.toContain("'x'");
    expect(results).toEqual([{ status: "done", ms: expect.any(Number), errors: 2, added: [expect.objectContaining({ file: "src/b.ts" })] }]);
    expect(statuses).toEqual([true, false]);
    // The same errors again: nothing new.
    expect(await checks.afterStep(changed)).toBeNull();
  });

  test("a step that changed no file isn't checked", async () => {
    const run = fake(ok());
    const { checks } = turn(new Diagnostics({ run, sandboxWorks: () => true }));
    await checks.beforeChange();
    expect(await checks.afterStep(unchanged)).toBeNull();
    expect(run.runs).toBe(1);
  });

  test("without a baseline this turn (nothing was changed through the edit tools), nothing runs", async () => {
    const run = fake();
    const { checks } = turn(new Diagnostics({ run, sandboxWorks: () => true }));
    expect(await checks.afterStep(changed)).toBeNull();
    expect(run.runs).toBe(0);
  });

  test("not a TypeScript project: nothing runs", async () => {
    rmSync(join(root, "tsconfig.json"));
    const run = fake();
    const { checks, results } = turn(new Diagnostics({ run, sandboxWorks: () => true }));
    await checks.beforeChange();
    expect(await checks.afterStep(changed)).toBeNull();
    expect(run.runs).toBe(0);
    expect(results).toEqual([]);
  });

  test("without the sandbox nothing runs, and the first change says so once per session", async () => {
    const run = fake();
    const diagnostics = new Diagnostics({ run, sandboxWorks: () => true });
    const first = turn(diagnostics, { sandbox: false });
    await first.checks.beforeChange();
    await first.checks.beforeChange();
    expect(await first.checks.afterStep(changed)).toBeNull();
    const second = turn(diagnostics, { sandbox: false });
    await second.checks.beforeChange();
    expect(run.runs).toBe(0);
    expect([...first.results, ...second.results]).toEqual([{ status: "off", reason: "no-sandbox" }]);
  });

  test("bwrap not working counts as no sandbox", async () => {
    const run = fake();
    const { checks, results } = turn(new Diagnostics({ run, sandboxWorks: () => false }));
    await checks.beforeChange();
    expect(run.runs).toBe(0);
    expect(results).toEqual([{ status: "off", reason: "no-sandbox" }]);
  });

  test("two timeouts turn checking off for the session, said once", async () => {
    const timedOut: CommandResult = { output: "", exitCode: null, timedOut: true, aborted: false };
    const run = fake(timedOut, timedOut);
    const diagnostics = new Diagnostics({ run, sandboxWorks: () => true });
    const first = turn(diagnostics);
    await first.checks.beforeChange();
    expect(await first.checks.afterStep(changed)).toBeNull(); // no baseline: nothing to compare with
    const second = turn(diagnostics);
    await second.checks.beforeChange();
    const third = turn(diagnostics);
    await third.checks.beforeChange();
    expect(run.runs).toBe(2);
    expect([...first.results, ...second.results, ...third.results].map((r) => r.status)).toEqual(["failed", "failed", "off"]);
    expect(second.results.at(-1)).toEqual({ status: "off", reason: "timeouts" });
  });

  test("output that can't be read tells the model nothing", async () => {
    const run = fake(ok(), failed("Segmentation fault\n"));
    const { checks, results } = turn(new Diagnostics({ run, sandboxWorks: () => true }));
    await checks.beforeChange();
    expect(await checks.afterStep(changed)).toBeNull();
    expect(results).toEqual([{ status: "failed", ms: expect.any(Number), reason: "unreadable" }]);
  });

  test("a check stopped by Esc tells the model nothing and isn't a failure", async () => {
    const run = fake(ok(), { output: "", exitCode: null, timedOut: false, aborted: true });
    const { checks, results } = turn(new Diagnostics({ run, sandboxWorks: () => true }));
    await checks.beforeChange();
    expect(await checks.afterStep(changed)).toBeNull();
    expect(results).toEqual([]);
  });

  test("a runner that throws counts as unreadable, and beforeChange never rejects", async () => {
    const run: RunCheck = async () => {
      throw new Error("spawn failed");
    };
    const { checks, results } = turn(new Diagnostics({ run, sandboxWorks: () => true }));
    await checks.beforeChange();
    expect(results).toEqual([{ status: "failed", ms: expect.any(Number), reason: "unreadable" }]);
  });
});

describe("checkNotice", () => {
  test("new errors: the first five, then how many more", () => {
    const added = Array.from({ length: 7 }, (_, i) => ({ file: "a.ts", line: i + 1, column: 1, code: "TS2304", message: `Cannot find name 'v${i}'.` }));
    const text = checkNotice({ status: "done", ms: 5, errors: 7, added })!;
    expect(text.split("\n")[0]).toBe("✻ Typecheck: 7 new errors, told the model:");
    expect(text.split("\n")).toHaveLength(1 + 5 + 1);
    expect(text).toContain("… and 2 more");
  });

  test("nothing for a clean check or a failure; one line when checking is off", () => {
    expect(checkNotice({ status: "done", ms: 5, errors: 0, added: [] })).toBeNull();
    expect(checkNotice({ status: "failed", ms: 5, reason: "timeout" })).toBeNull();
    expect(checkNotice({ status: "off", reason: "no-sandbox" })).toContain("sandbox");
    expect(checkNotice({ status: "off", reason: "timeouts" })).toContain("stopped");
  });

  test("escape sequences in an error message never reach the terminal", () => {
    const text = checkNotice({ status: "done", ms: 5, errors: 1, added: [{ file: "a.ts", line: 1, column: 1, code: "TS2322", message: "Type '\u001b]52;c;aGk=\u0007' is wrong." }] })!;
    expect(text).not.toContain("\u001b");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test tests/diagnostics-turn`
Expected: FAIL, `Cannot find module '../src/diagnostics/turn.ts'`.

- [ ] **Step 3: Write the module**

`src/diagnostics/turn.ts`:

```ts
// The typecheck after a step's file changes (docs/superpowers/specs/2026-10-08-post-edit-diagnostics-design.md). A
// baseline is taken before the turn's first change; after each step that changed a file, the check runs again and
// the model is told only the errors that are new, anywhere in the project. The compiler is the project's own code,
// which a cloned repository could have planted, so it runs in the sandbox with the project read-only, and without
// the sandbox it doesn't run at all.
import { printable } from "../printable.ts";
import { sandboxAvailable } from "../sandbox.ts";
import { runCommand, type CommandResult } from "../tools/bash.ts";
import type { ToolResult } from "../tools/types.ts";
import { checkCommand, detectChecker, diagnosticsNote, formatError, newErrors, parseTsc, type TsError } from "./tsc.ts";

/** Per check. TypeScript 7 checks Marv itself (24k lines) in half a second; TypeScript 5 is about ten times slower. */
export const CHECK_TIMEOUT_MS = 60_000;
/** Timeouts after which a session stops checking: a huge project would otherwise add a minute to every step. */
const MAX_TIMEOUTS = 2;
/** Errors the transcript shows (the model gets up to MAX_REPORTED). */
const NOTICE_LINES = 5;

export type CheckResult =
  /** It ran. `added`: the errors the model was told about (none: nothing was said). */
  | { status: "done"; ms: number; errors: number; added: TsError[] }
  /** It couldn't tell what's new, so nothing was said. */
  | { status: "failed"; ms: number; reason: "timeout" | "unreadable" }
  /** No checks from here on (said once per session). */
  | { status: "off"; reason: "no-sandbox" | "timeouts" };

/** Runs the check command; tests pass a stand-in. */
export type RunCheck = (command: string, opts: { root: string; signal: AbortSignal; timeoutMs: number }) => Promise<CommandResult>;

const sandboxed: RunCheck = (command, { root, signal, timeoutMs }) =>
  runCommand({ command, root, sandbox: true, network: false, projectReadOnly: true, timeoutMs, signal });

/** What the session hands the tools (beforeChange) and the loop (afterStep) for one turn. */
export interface TurnChecks {
  /** Takes the baseline before the turn's first change; later calls wait for the same one. Never rejects. */
  beforeChange(): Promise<void>;
  /** After a step: the note for the model when its file changes added errors, otherwise null. */
  afterStep(results: ToolResult[]): Promise<string | null>;
}

const NONE: TurnChecks = { beforeChange: async () => {}, afterStep: async () => null };

interface TurnOptions {
  root: string;
  /** The session's sandbox setting: checks need it on, and bwrap working. */
  sandbox: boolean;
  signal: AbortSignal;
  /** True while a step's check runs ("Checking types…"), false after. */
  onStatus: (checking: boolean) => void;
  onResult: (result: CheckResult) => void;
}

/** One per session: what lasts from turn to turn. */
export class Diagnostics {
  private timeouts = 0;
  private toldNoSandbox = false;

  constructor(private readonly opts: { run?: RunCheck; timeoutMs?: number; sandboxWorks?: () => boolean } = {}) {}

  turn({ root, sandbox, signal, onStatus, onResult }: TurnOptions): TurnChecks {
    const bin = detectChecker(root);
    if (!bin || this.timeouts >= MAX_TIMEOUTS) return NONE;
    if (!sandbox || !(this.opts.sandboxWorks ?? sandboxAvailable)()) {
      return {
        // Said when it would have mattered (the first change), not on every turn of a project nobody edits.
        beforeChange: async () => {
          if (this.toldNoSandbox) return;
          this.toldNoSandbox = true;
          onResult({ status: "off", reason: "no-sandbox" });
        },
        afterStep: async () => null,
      };
    }
    const run = this.opts.run ?? sandboxed;
    const check = async (): Promise<{ errors: TsError[]; ms: number } | null> => {
      const started = Date.now();
      let result: CommandResult;
      try {
        result = await run(checkCommand(bin), { root, signal, timeoutMs: this.opts.timeoutMs ?? CHECK_TIMEOUT_MS });
      } catch {
        onResult({ status: "failed", ms: Date.now() - started, reason: "unreadable" });
        return null;
      }
      const ms = Date.now() - started;
      if (result.aborted) return null; // Esc: the turn is ending, nothing to say
      if (result.timedOut) {
        this.timeouts++;
        onResult({ status: "failed", ms, reason: "timeout" });
        if (this.timeouts === MAX_TIMEOUTS) onResult({ status: "off", reason: "timeouts" });
        return null;
      }
      const errors = parseTsc(result.output, result.exitCode);
      if (!errors) {
        onResult({ status: "failed", ms, reason: "unreadable" });
        return null;
      }
      return { errors, ms };
    };
    let baseline: Promise<{ errors: TsError[]; ms: number } | null> | undefined;
    return {
      beforeChange: async () => {
        await (baseline ??= check());
      },
      afterStep: async (results) => {
        if (!baseline || !results.some((r) => r.diff)) return null;
        const before = await baseline;
        if (!before || signal.aborted || this.timeouts >= MAX_TIMEOUTS) return null;
        onStatus(true);
        let now: { errors: TsError[]; ms: number } | null;
        try {
          now = await check();
        } finally {
          onStatus(false);
        }
        if (!now) return null;
        baseline = Promise.resolve(now); // each error is told once, when it first appears
        const added = newErrors(before.errors, now.errors);
        onResult({ status: "done", ms: now.ms, errors: now.errors.length, added });
        return added.length ? diagnosticsNote(added) : null;
      },
    };
  }
}

/** What the transcript shows for a check, or null for nothing. Error messages quote the project's code: printable. */
export function checkNotice(result: CheckResult): string | null {
  if (result.status === "off") {
    return result.reason === "no-sandbox"
      ? "✻ Marv typechecks after the model's edits only in the sandbox (it runs the project's own compiler), so it won't here."
      : "✻ The typecheck took over a minute twice, so Marv stopped running it for this session.";
  }
  if (result.status !== "done" || result.added.length === 0) return null;
  const n = result.added.length;
  const shown = result.added.slice(0, NOTICE_LINES).map((e) => printable(formatError(e)));
  return [`✻ Typecheck: ${n} new error${n === 1 ? "" : "s"}, told the model:`, ...shown, ...(n > shown.length ? [`… and ${n - shown.length} more`] : [])].join("\n");
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test tests/diagnostics-turn && bun run typecheck`
Expected: all pass; no type errors. (If `printable` keeps the newlines inside a continuation line differently, check `src/printable.ts`. It keeps `\n` and drops ESC, so the escape-sequence test holds.)

- [ ] **Step 5: Commit**

```bash
git add src/diagnostics/turn.ts tests/diagnostics-turn.test.ts
git commit -m "Diagnostics: a turn's baseline and step checks, sandboxed, #13"
```

### Task 4: `runAgent`'s `afterStep` hook

**Files:**
- Modify: `src/agent.ts` (`Options`, `runAgent`)
- Test: `tests/agent.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent.test.ts`. It already has `ScriptedProvider`, `say`, `useTools`, `call(id, path)`, `fakeTool` and `run(provider, history, opts)`:

```ts
describe("afterStep", () => {
  test("its note goes in after all of the step's tool results, as a message from Marv, before the next request", async () => {
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts"), call("c2", "b.ts")), say("Fixed.")]);
    const history: ChatTurn[] = [{ role: "user", text: "go" }];
    const seen: string[][] = [];
    await run(provider, history, { afterStep: async (results) => (seen.push(results.map((r) => r.output)), "Marv: 1 new error") });
    expect(seen).toEqual([["contents of a.ts", "contents of b.ts"]]);
    const second = provider.requests[1]!.history;
    expect(second.slice(-3).map((t) => t.role)).toEqual(["tool", "tool", "user"]);
    expect(second.at(-1)).toEqual({ role: "user", text: "Marv: 1 new error" });
    // Appended, not inserted: the second request still starts with the first one (prompt cache).
    expect(second.slice(0, provider.requests[0]!.history.length)).toEqual(provider.requests[0]!.history);
  });

  test("null adds nothing", async () => {
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts")), say("Done.")]);
    await run(provider, [{ role: "user", text: "go" }], { afterStep: async () => null });
    expect(provider.requests[1]!.history.at(-1)?.role).toBe("tool");
  });

  test("not called after a plain answer", async () => {
    let calls = 0;
    await run(new ScriptedProvider([say("Hi.")]), [{ role: "user", text: "hi" }], { afterStep: async () => (calls++, null) });
    expect(calls).toBe(0);
  });

  test("stopped during it: the run ends there, every call answered, and the note isn't added", async () => {
    const stop = new AbortController();
    const provider = new ScriptedProvider([useTools(call("c1", "a.ts")), say("never asked")]);
    const history: ChatTurn[] = [{ role: "user", text: "go" }];
    const events = await run(provider, history, {
      signal: stop.signal,
      afterStep: async () => {
        stop.abort();
        return "Marv: too late";
      },
    });
    expect(events.at(-1)).toEqual({ type: "done", reason: "aborted" });
    expect(provider.requests).toHaveLength(1);
    expect(history.at(-1)?.role).toBe("tool");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test tests/agent -t "afterStep"`
Expected: FAIL (the note isn't in the second request; `afterStep` is never called).

- [ ] **Step 3: Implement**

In `src/agent.ts`, add to `interface Options`, after `maxParallel?: number;`:

```ts
  /**
   * After a step's tool calls are all answered, when the run goes on: a note for the model, appended as a message
   * from Marv before the next request (like CUT_OFF_NOTE), or null. The session's typecheck uses it (src/diagnostics).
   */
  afterStep?: (results: ToolResult[]) => Promise<string | null>;
```

Add `afterStep,` to `runAgent`'s destructured parameters (after `maxParallel = MAX_PARALLEL,`).

In the step's tool-running section, collect the results. Right before `let declined = false;` add:

```ts
    // Every result of this step, in call order, for afterStep.
    const stepResults: ToolResult[] = [];
```

Right after `group.forEach((call, k) => answer(call, results[k]!.output));` add:

```ts
        stepResults.push(...results);
```

At the end of the step, after the block

```ts
    if (declined) {
      yield { type: "done", reason: "declined" };
      return;
    }
```

(still inside the `for (let step = 0; ; step++)` loop), add:

```ts
    if (afterStep) {
      const note = await afterStep(stepResults);
      if (signal.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      if (note) history.push({ role: "user", text: note });
    }
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test tests/agent && bun run typecheck`
Expected: all pass (the existing "every request extends the previous one exactly" test too); no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts tests/agent.test.ts
git commit -m "runAgent: afterStep, a note for the model after a step's tool results, #13"
```

### Task 5: The edit tools take the baseline before writing

**Files:**
- Modify: `src/tools/types.ts` (`ToolContext`)
- Modify: `src/tools/edit-file.ts` (`preview`, `run`)
- Modify: `src/tools/write-file.ts` (`preview`, `run`)
- Test: `tests/write-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/write-tools.test.ts`. It has `root` (with `greet.ts`, whose content includes `Hello`), `call(name, args)` and `read(path)`, and imports `runTool`:

```ts
describe("beforeChange", () => {
  for (const [name, args, path] of [
    ["edit_file", { path: "greet.ts", old_string: "Hello", new_string: "Hi" }, "greet.ts"],
    ["write_file", { path: "new.ts", content: "export {};\n" }, "new.ts"],
  ] as const) {
    test(`${name}: the preview starts it (before the user is asked), and the file is written only once it's done`, async () => {
      let started = 0;
      let release!: () => void;
      const baseline = new Promise<void>((resolve) => (release = resolve));
      const startedWhenAsked: number[] = [];
      const pending = runTool(call(name, args), {
        root,
        sandbox: false,
        approve: async () => (startedWhenAsked.push(started), "yes"),
        beforeChange: () => (started++, baseline),
      });
      await Bun.sleep(30);
      expect(startedWhenAsked).toEqual([1]);
      // Approved, but still waiting for the baseline: nothing written yet.
      if (path === "greet.ts") expect(await read(path)).toContain("Hello");
      else expect(existsSync(join(root, path))).toBe(false);
      release();
      expect((await pending).isError).toBeFalsy();
      if (path === "greet.ts") expect(await read(path)).toContain("Hi");
      else expect(await read(path)).toBe("export {};\n");
    });
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/write-tools -t "beforeChange"`
Expected: FAIL (`startedWhenAsked` is `[0]`, and the file is written before `release()`). `bun run typecheck` reports `beforeChange` as an unknown property.

- [ ] **Step 3: Implement**

In `src/tools/types.ts`, add to `ToolContext`, after `gitEnv?: Record<string, string>;`:

```ts
  /**
   * Before a file change: the preview starts it (not awaited, so it can run while the user decides), and the change
   * waits for it before writing. The session takes the typecheck's baseline there (src/diagnostics), so the
   * baseline sees the project as it was. Never rejects.
   */
  beforeChange?: () => Promise<void>;
```

In `src/tools/edit-file.ts`, make the first line of `async preview(args, ctx) {`:

```ts
    void ctx.beforeChange?.();
```

and make the first line of `async run(args, ctx) {` (before the "Planned again" comment):

```ts
    await ctx.beforeChange?.();
```

In `src/tools/write-file.ts`, the same: `void ctx.beforeChange?.();` as the first line of `preview`, and `await ctx.beforeChange?.();` as the first line of `run`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `bun test tests/write-tools && bun run typecheck`
Expected: all pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/types.ts src/tools/edit-file.ts src/tools/write-file.ts tests/write-tools.test.ts
git commit -m "edit_file, write_file: beforeChange, started by the preview and awaited before writing, #13"
```

### Task 6: The session runs the checks; trajectories and the SDK

**Files:**
- Modify: `src/session.ts` (`SessionEvent`, `SessionInit`, `Session.configure`, `MarvSession`: constructor, `configure`, `runTurn`)
- Modify: `src/trajectory.ts` (`TrajectoryRecord`)
- Modify: `src/sdk.ts` (options and `createSession`)
- Test: `tests/session.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/session.test.ts`, add the imports:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { Diagnostics, type RunCheck } from "../src/diagnostics/turn.ts";
import type { CommandResult } from "../src/tools/bash.ts";
```

(`existsSync` is already imported from `node:fs`: merge them into one import.) Then append:

```ts
describe("diagnostics", () => {
  const ok: CommandResult = { output: "", exitCode: 0, timedOut: false, aborted: false };
  const broken: CommandResult = { output: "src/b.ts(1,1): error TS2304: Cannot find name 'x'.\n", exitCode: 2, timedOut: false, aborted: false };
  const write = (id: string) => call(id, "write_file", { path: "a.ts", content: "export const a = 1;\n" });
  /** The project as a TypeScript one, and a stand-in tsc that answers in turn and notes whether a.ts existed each time. */
  function typescriptProject(...answers: CommandResult[]) {
    mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(project, "node_modules", ".bin", "tsc"), "");
    const sawFile: boolean[] = [];
    const run: RunCheck = async () => (sawFile.push(existsSync(join(project, "a.ts"))), answers.shift() ?? ok);
    return { checks: new Diagnostics({ run, sandboxWorks: () => true }), sawFile };
  }
  beforeEach(async () => writeFile(join(project, "tsconfig.json"), "{}"));

  test("new errors after a step that changed a file reach the model, after the tool results", async () => {
    const { checks } = typescriptProject(ok, broken);
    const provider = new ScriptedProvider([useTools(write("c1")), say("Done.")]);
    const events = await collect(makeSession(provider, { checks }).send("go"));
    const second = provider.requests[1]!.history;
    expect(second.at(-2)?.role).toBe("tool");
    expect(second.at(-1)).toEqual({ role: "user", text: expect.stringContaining("src/b.ts:1:1 TS2304 Cannot find name 'x'.") });
    expect(events).toContainEqual({ type: "status", status: "checking" });
    expect(events).toContainEqual({ type: "check", result: expect.objectContaining({ status: "done", errors: 1 }) });
  });

  test("the baseline is taken before the file is written, also in yolo mode", async () => {
    const { checks, sawFile } = typescriptProject(ok, ok);
    await collect(makeSession(new ScriptedProvider([useTools(write("c1")), say("Done.")]), { checks }).send("go"));
    expect(sawFile).toEqual([false, true]);
  });

  test("diagnostics: false runs nothing, and configure() turns it on from the next turn", async () => {
    const { checks, sawFile } = typescriptProject(ok, ok);
    const session = makeSession(new ScriptedProvider([useTools(write("c1")), say("Done."), useTools(write("c2")), say("Done.")]), { checks, diagnostics: false });
    await collect(session.send("go"));
    expect(sawFile).toEqual([]);
    session.configure({ diagnostics: true });
    await collect(session.send("again"));
    expect(sawFile).toHaveLength(2);
  });

  test("the check is in the trajectory", async () => {
    const { checks } = typescriptProject(ok, broken);
    const trajectories = new TrajectoryStore(dir);
    const session = makeSession(new ScriptedProvider([useTools(write("c1")), say("Done.")]), { checks, trajectories });
    await collect(session.send("go"));
    await session.flush();
    const files = await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan(dir));
    const records = (await readFile(join(dir, files[0]!), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({ type: "check", agent: "main", status: "done", errors: 1, added: 1 }));
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test tests/session -t "diagnostics"`
Expected: FAIL. `bun run typecheck` reports `checks`/`diagnostics` as unknown properties.

- [ ] **Step 3: The trajectory record**

In `src/trajectory.ts`, add to `TrajectoryRecord`, after the `empty_reply` member:

```ts
  /** The typecheck after a step's file changes (src/diagnostics): how it went, and how many errors were new. */
  | (Who & { type: "check"; status: "done" | "failed" | "off"; ms?: number; errors?: number; added?: number; reason?: string })
```

- [ ] **Step 4: The session**

In `src/session.ts`:

1. Import: `import { Diagnostics, type CheckResult } from "./diagnostics/turn.ts";`
2. In `SessionEvent`, change the status line to `| { type: "status"; status: "waiting_for_mcp" | "compacting" | "checking" | "running" }` and add, after the `compaction` member:

```ts
  /** The typecheck after a step's file changes (src/diagnostics): new errors, a failure, or that it's off. */
  | { type: "check"; result: CheckResult }
```

3. In `SessionInit`, after `maxSteps?: number;`:

```ts
  /** Typecheck after each step that changed files (TypeScript projects, in the sandbox), and tell the model about new errors. Default true. */
  diagnostics?: boolean;
  /** The typecheck's session state; tests pass one with a stand-in runner. */
  checks?: Diagnostics;
```

4. In the `Session` interface's `configure(changes: …)` and in `MarvSession.configure`'s parameter type, add `diagnostics?: boolean;`. In `MarvSession.configure`'s body, after `if (changes.trajectories !== undefined) this.logging = changes.trajectories;`:

```ts
    if (changes.diagnostics !== undefined) this.diagnostics = changes.diagnostics;
```

5. Add fields next to `private sandbox: boolean;`:

```ts
  private diagnostics: boolean;
  private readonly checks: Diagnostics;
```

and in the constructor, next to `this.yolo = init.yolo ?? true;`:

```ts
    this.diagnostics = init.diagnostics ?? true;
    this.checks = init.checks ?? new Diagnostics();
```

6. In `runTurn`, change `const { sandbox, yolo, factory, provider, info } = this;` to `const { sandbox, yolo, factory, provider, info, diagnostics } = this;`. Right after `const approve = this.approver(stop.signal);` add:

```ts
      // The typecheck after file changes: a baseline before the first, a check after each step that made one.
      const checks = diagnostics
        ? this.checks.turn({
            root: this.init.root,
            sandbox,
            signal: stop.signal,
            onStatus: (checking) => emit({ type: "status", status: checking ? "checking" : "running" }),
            onResult: (result) => {
              emit({ type: "check", result });
              record(
                result.status === "done"
                  ? { type: "check", turn, agent: "main", status: "done", ms: result.ms, errors: result.errors, added: result.added.length }
                  : result.status === "failed"
                    ? { type: "check", turn, agent: "main", status: "failed", ms: result.ms, reason: result.reason }
                    : { type: "check", turn, agent: "main", status: "off", reason: result.reason },
              );
            },
          })
        : undefined;
```

7. In the main `runTool(call, { root: this.init.root, signal: stop.signal, approve, sandbox, yolo, … }, tools)` context, add `beforeChange: checks?.beforeChange,`. In the `runAgent({ … })` options, add `afterStep: checks?.afterStep,` (next to `maxSteps`).


- [ ] **Step 5: The SDK**

In `src/sdk.ts`, add to the options interface, after `maxSteps?: number;`:

```ts
  /**
   * After a step that changed files in a TypeScript project (a tsconfig.json and node_modules/.bin/tsc), run the
   * project's typecheck in the sandbox, read-only, and tell the model about new errors. Default true. Without the
   * sandbox it doesn't run (the compiler is the project's own code).
   */
  diagnostics?: boolean;
```

and in `createSession`'s `new MarvSession({ … })`, after `maxSteps: options.maxSteps,`: `diagnostics: options.diagnostics,`.

- [ ] **Step 6: Run the tests**

Run: `bun test tests/session && bun run typecheck`
Expected: all pass. Typecheck: if a `switch` over `SessionEvent` somewhere is exhaustive, it reports the new `check` event. Handle it there with a `case "check": break;` (the App gets real handling in Task 7).

- [ ] **Step 7: Run the whole suite and commit**

Run: `bun test`
Expected: 0 fail.

```bash
git add src/session.ts src/trajectory.ts src/sdk.ts tests/session.test.ts
git commit -m "Session: the typecheck after file changes (diagnostics, on by default), check events and records, #13"
```

### Task 7: Config, `/diagnostics`, and the TUI

**Files:**
- Modify: `src/config/config.ts` (`FileConfigSchema`, `Config`, `resolveConfig`)
- Modify: `src/commands/index.ts` (`CommandAction`, `commands`, the `/config` text, `diagnosticsStatus`)
- Modify: `src/app.tsx` (session creation, configure effect, actions, events)
- Test: `tests/config.test.ts`, `tests/commands.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/commands.test.ts`, add after the `/trajectories` test:

```ts
  test("/diagnostics says what it does, or turns it on and off", () => {
    expect(runCommand("/diagnostics off")).toEqual({ type: "diagnostics", on: false });
    expect(runCommand("/diagnostics on")).toEqual({ type: "diagnostics", on: true });
    expect(runCommand("/diagnostics")).toMatchObject({ type: "print", text: expect.stringContaining("typecheck") });
    expect(runCommand("/diagnostics maybe")).toMatchObject({ type: "print", isError: true });
    expect(runCommand("/config")).toMatchObject({ type: "print", text: expect.stringContaining("Diagnostics: on") });
  });
```

The full `Config` literals in the tests gain the new field. In `tests/commands.test.ts` (the context's `config`, around line 16, and the ollama `/config` literal around line 52), and in `tests/config.test.ts:47` (`resolveConfig(file, {})` expectation), add `diagnostics: true` next to `trajectories: true`. In `tests/config.test.ts`, also add:

```ts
  test("diagnostics: on unless the file turns it off", () => {
    expect(resolveConfig({ provider: "ollama" }, {}).diagnostics).toBe(true);
    expect(resolveConfig({ provider: "ollama", diagnostics: false }, {}).diagnostics).toBe(false);
  });
```

(Put it in the `describe` that holds the other `resolveConfig` tests. If `{ provider: "ollama" }` isn't a valid `FileConfig` there, copy the minimal file literal the neighbouring tests use.)

- [ ] **Step 2: Run them to make sure they fail**

Run: `bun test tests/commands tests/config`
Expected: FAIL.

- [ ] **Step 3: Config**

In `src/config/config.ts`, add to `FileConfigSchema` after `trajectories`:

```ts
  /** Typecheck after the model changes files, and tell it about new errors (default on). */
  diagnostics: z.boolean().optional(),
```

add `diagnostics: boolean;` to `Config` after `trajectories: boolean;`, and in `resolveConfig`'s return, after `trajectories: file?.trajectories ?? true,`:

```ts
    diagnostics: file?.diagnostics ?? true,
```

- [ ] **Step 4: The command**

In `src/commands/index.ts`, add `| { type: "diagnostics"; on: boolean }` to `CommandAction` after the `trajectories` member. Add this command to `commands`, right after the `trajectories` command:

```ts
  {
    name: "diagnostics",
    description: "Typecheck after the model's edits (/diagnostics on, /diagnostics off)",
    run: (args, { config }) => {
      const arg = args.toLowerCase();
      if (arg === "on" || arg === "off") return { type: "diagnostics", on: arg === "on" };
      if (arg) return { type: "print", text: "Usage: /diagnostics, /diagnostics on, or /diagnostics off", isError: true };
      return { type: "print", text: `Diagnostics: ${diagnosticsStatus(config)}` };
    },
  },
```

In the `/config` text (the array with `Trajectories: …`), after that line add:

```ts
    `Diagnostics: ${config.diagnostics ? "on" : "off"} (/diagnostics)`,
```

and next to `export function trajectoriesStatus`, add:

```ts
export function diagnosticsStatus(config: Config): string {
  return config.diagnostics
    ? "on: after the model changes files in a TypeScript project, Marv runs the project's typecheck (in the sandbox, read-only) and tells the model about new errors"
    : "off";
}
```

- [ ] **Step 5: The App**

In `src/app.tsx`:

1. Add `diagnosticsStatus` to the import from `./commands/index.ts`, and add `import { checkNotice } from "./diagnostics/turn.ts";`.
2. In `new MarvSession({ … })`, after `yolo: config.yolo,`: `diagnostics: config.diagnostics,`. In the configure effect's `session.configure({ … })`, after `trajectories: config.trajectories,`: `diagnostics: config.diagnostics,`. Update that effect's comment to list `/diagnostics` too.
3. In the action `switch`, after the `case "trajectories":` block:

```ts
      case "diagnostics":
        void saveConfig({ ...(file ?? { provider: config.provider }), diagnostics: action.on }, `Diagnostics ${diagnosticsStatus({ ...config, diagnostics: action.on })}`);
        break;
```

4. In the event loop, `case "status":` becomes:

```ts
            case "status":
              setWaitingFor(event.status === "waiting_for_mcp" ? "Waiting for MCP servers to start…" : event.status === "checking" ? "Checking types…" : null);
              setCompacting(event.status === "compacting");
              break;
```

and add, next to `case "compaction":`:

```ts
            case "check": {
              const notice = checkNotice(event.result);
              if (notice) addMessage({ role: "system", text: notice });
              break;
            }
```

(If Task 6 added a placeholder `case "check": break;` here, replace it.)

- [ ] **Step 6: Run the tests**

Run: `bun test tests/commands tests/config && bun run typecheck && bun test`
Expected: all pass; no type errors; the full suite 0 fail.

- [ ] **Step 7: Try it in the TUI**

Run Marv with a throwaway config, in a TypeScript project. Marv itself works: `MARV_CONFIG_DIR=$(mktemp -d) bun run dev` (that config dir has no key, so setup opens: pick Ollama if it's running, or paste an OpenRouter key). Then:
- Ask for something that changes a file without breaking types (e.g. "add a comment at the top of src/printable.ts"). Expect a short "Checking types…" after the edit and no notice. Then undo it with `git checkout src/printable.ts`.
- Type `/diagnostics`. It explains what it does. `/diagnostics off` → `/config` shows `Diagnostics: off`.

If no model is available, skip this step and say so in the report.

- [ ] **Step 8: Commit**

```bash
git add src/config/config.ts src/commands/index.ts src/app.tsx tests/commands.test.ts tests/config.test.ts
git commit -m "/diagnostics, the diagnostics config key, and the TUI's Checking types… line and notice, #13"
```

### Task 8: End to end with the real compiler

**Files:**
- Create: `tests/diagnostics-e2e.test.ts`

- [ ] **Step 1: Write the test**

`tests/diagnostics-e2e.test.ts`:

```ts
// The whole path with the real TypeScript compiler, in the real sandbox: Marv's own TypeScript, copied into a temp
// project the way the evals do it (evals/typescript.ts).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTypeScript } from "../evals/typescript.ts";
import type { AgentEvent, ToolCall } from "../src/provider/types.ts";
import { sandboxAvailable } from "../src/sandbox.ts";
import { MarvSession, type SessionEvent } from "../src/session.ts";
import { ScriptedProvider } from "./fake-provider.ts";

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ESNext", module: "Preserve", moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true, strict: true, skipLibCheck: true, types: [] },
  include: ["src"],
});
const say = (text: string): AgentEvent[] => [{ type: "text_delta", text }, { type: "done", reason: "stop" }];
const write = (path: string, content: string): AgentEvent[] => [
  { type: "tool_call", call: { id: `w-${path}`, name: "write_file", arguments: JSON.stringify({ path, content }) } satisfies ToolCall },
  { type: "done", reason: "tool_calls" },
];

describe.if(sandboxAvailable())("the typecheck after a change, with the real tsc in the sandbox", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "marv-tsc-e2e-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(root, "src", "format.ts"), "export function formatPrice(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n");
    writeFileSync(join(root, "src", "cart.ts"), 'import { formatPrice } from "./format.ts";\n\nexport const total = (cents: number) => formatPrice(cents);\n');
    addTypeScript(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  async function turn(...steps: AgentEvent[][]) {
    const provider = new ScriptedProvider([...steps, say("Done.")]);
    const session = new MarvSession({ root, provider: { id: "test", model: "test", make: () => provider } });
    const events: SessionEvent[] = [];
    for await (const event of session.send("go")) events.push(event);
    await session.close();
    return { provider, events };
  }

  test("renaming an export: the model is told about the caller it broke, in a file it didn't touch", async () => {
    const { provider } = await turn(write("src/format.ts", "export function formatMoney(cents: number): string {\n  return (cents / 100).toFixed(2);\n}\n"));
    const note = provider.requests[1]!.history.at(-1);
    expect(note?.role).toBe("user");
    expect(note?.text).toStartWith("Marv: the typecheck (tsc) after your changes found");
    expect(note?.text).toContain("src/cart.ts:1:");
    expect(note?.text).toContain("formatPrice");
  }, 30_000);

  test("a change that breaks nothing adds nothing", async () => {
    const { provider } = await turn(write("src/extra.ts", "export const extra = 1;\n"));
    expect(provider.requests[1]!.history.at(-1)?.role).toBe("tool");
  }, 30_000);

  test("errors that were already there aren't blamed on the model", async () => {
    writeFileSync(join(root, "src", "old.ts"), "export const broken: number = 'not a number';\n");
    const { provider, events } = await turn(write("src/extra.ts", "export const extra = 1;\n"));
    expect(provider.requests[1]!.history.at(-1)?.role).toBe("tool");
    expect(events).toContainEqual({ type: "check", result: expect.objectContaining({ status: "done", errors: 1, added: [] }) });
  }, 30_000);
});
```

- [ ] **Step 2: Run it**

Run: `bun test tests/diagnostics-e2e`
Expected: 3 pass on a machine with bwrap; skipped without it. If the first test fails because TypeScript 7's message differs, read the actual note in the failure output. The assertions only need the file (`src/cart.ts:1:`) and the name (`formatPrice`), not the exact wording.

- [ ] **Step 3: Commit**

```bash
git add tests/diagnostics-e2e.test.ts
git commit -m "Diagnostics: end to end with the real tsc in the sandbox, #13"
```

### Task 9: The evals can turn diagnostics on and off

**Files:**
- Modify: `evals/run.ts`
- Modify: `evals/summary.ts` (`RunResult`)

- [ ] **Step 1: Implement**

In `evals/summary.ts`, add to `RunResult` after `ranTypecheck?: boolean;`:

```ts
  /** Steps after which Marv told the model about new type errors (post-edit diagnostics). */
  checkNotes?: number;
```

In `evals/run.ts`:
- In the usage comment at the top, append ` [--diagnostics on|off]` to the `--models` line's option list.
- After the `maxSteps` constant, add:

```ts
// Marv's typecheck after file changes (on by default, as in the CLI); off for the comparison's other arm.
const diagnostics = option("diagnostics") !== "off";
```

- Pass it: `createSession({ cwd: dir, provider: { kind: "openrouter", apiKey, model }, maxSteps, diagnostics })`.
- In `runOne`'s event loop, add next to the `empty_reply` handling:

```ts
        if (event.type === "check") {
          if (event.result.status === "done" && event.result.added.length) result.checkNotes = (result.checkNotes ?? 0) + 1;
          log.push({ check: event.result });
        }
```

- In the start line, change `${maxSteps} steps,` to `${maxSteps} steps, diagnostics ${diagnostics ? "on" : "off"},`.

- [ ] **Step 2: Check it**

Run: `bun run typecheck && bun test tests/eval && bun run eval --verify`
Expected: no type errors; eval tests pass; `--verify` prints 13 `ok` lines (it doesn't use sessions, so it's unchanged).

- [ ] **Step 3: Commit**

```bash
git add evals/run.ts evals/summary.ts
git commit -m "Evals: --diagnostics on|off, and count the typecheck notes per run, #13"
```

### Task 10: Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: CLAUDE.md**

Add a new bullet to **Architecture**, after the **Yolo mode** bullet:

```markdown
- **Diagnostics (`src/diagnostics/`)**: after a step that changed files (a result with a `diff`), in a TypeScript project (`tsconfig.json` plus `node_modules/.bin/tsgo` or `tsc`: `detectChecker`), Marv runs `tsc --noEmit --pretty false --incremental false -p tsconfig.json` and tells the model only the errors that are new since a baseline (`newErrors`: matched by file, code and message, not line, and counted, so a second copy is new), anywhere in the project, as a user message from Marv appended after the step's tool results (`diagnosticsNote`, at most 20, via `runAgent`'s `afterStep`; nothing new adds nothing, so the cache holds). The baseline is taken per turn before the first change: `ToolContext.beforeChange`, started (not awaited) by `edit_file`/`write_file`'s preview and awaited before writing, so it's right in yolo mode too; each check becomes the next baseline, so an error is told once. The compiler is project code, so it runs only sandboxed with the project read-only (`projectReadOnly` in `sandboxArgs`) and without network; with the sandbox off or bwrap missing it doesn't run (said once: `status: "off"`). 60 s per check; two timeouts turn it off for the session; output that isn't tsc's (`parseTsc` → null) or an Esc says nothing. `src/diagnostics/turn.ts` (`Diagnostics`, one per session; `turn()` gives the turn's `beforeChange`/`afterStep`) emits the session's `status: "checking"` ("Checking types…") and `check` events (`CheckResult`), and a `check` trajectory record. The TUI shows new errors as a `✻ Typecheck:` notice (first 5, `checkNotice`). On by default: config `diagnostics`, `/diagnostics on|off`, `SessionInit.diagnostics`, SDK `diagnostics`; `bun run eval --diagnostics off` for the comparison. Main agent only (subagents' edits are seen by its next check). Known limits: TypeScript only; solution-style tsconfigs (`files: []` + `references`) check nothing with `-p`; `composite` projects reject `--incremental false`.
```

In the **Sandbox** bullet, after "a caller can add `readOnly` folders (…)", add: "; Marv's own checks set `projectReadOnly`, which mounts the project read-only too". In the **Agent loop** bullet, after the sentence about `CUT_OFF_NOTE`, add: "`afterStep` (optional) runs after a step's tool calls are all answered, and its note, if any, is appended as a user message from Marv before the next request (the typecheck, see **Diagnostics**)."

- [ ] **Step 2: CHANGELOG.md**

Under `## [Unreleased]` → `### Added`, before the `maxSteps` entry:

```markdown
- After the model changes files in a TypeScript project, Marv runs the project's typecheck (in the sandbox, read-only) and tells the model about errors its changes added, anywhere in the project, so it fixes the callers it broke before saying it's done. `/diagnostics on|off`, config `diagnostics`, SDK option `diagnostics` (on by default). Needs the sandbox.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "Docs: post-edit diagnostics, #13"
```

### Task 11: Measure (spends money: ask the user first)

About 90 runs (two arms × 5 models × 3 TS tasks × 3 repetitions), roughly $0.35. Both arms run the same day with the same flags, because providers behind a model id change. Don't start without the user's go-ahead.

- [ ] **Step 1: Run both arms**

```bash
M=deepseek/deepseek-v4-flash,openai/gpt-5-nano,openai/gpt-oss-120b,qwen/qwen3.7-flash,z-ai/glm-5.3-flash
T=ts-rename-export,ts-required-field,ts-make-async
bun run eval --models $M --tasks $T --repeat 3 --timeout 600 --diagnostics off --label ts-diag-off --budget 0.6
bun run eval --models $M --tasks $T --repeat 3 --timeout 600 --diagnostics on --label ts-diag-on --budget 0.6
```

- [ ] **Step 2: Compare**

```bash
bun run eval --report evals/results/*-ts-diag-off/results.jsonl evals/results/*-ts-diag-on/results.jsonl
jq -r 'select(.checkNotes) | [.model, .task, .pass, .checkNotes] | @tsv' evals/results/*-ts-diag-on/results.jsonl
```

For each model, compare the pass rate and steps per run between the arms. The JavaScript tasks have no `tsconfig.json`, so the check never runs there (`detectChecker` returns null, covered by the "not a TypeScript project" test). Their behaviour can't change, so they're not rerun.

- [ ] **Step 3: Read the notes' effect**

For two or three runs with `checkNotes > 0`, open `evals/results/<stamp>-ts-diag-on/logs/<model>/<task>-<rep>.json`. After the `{ check: … }` entry, did the model fix the sites it was told about?

- [ ] **Step 4: Report on #13**

Comment on #13 with: the comparison table, per-model pass rates and steps for each arm, how often notes fired and what followed, and a recommendation. Ship it if it helps or is neutral at no cost. Otherwise, explain what to change. Leave #13 open: the user decides whether to merge.
