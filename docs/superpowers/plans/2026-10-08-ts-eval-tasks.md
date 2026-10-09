# TypeScript Eval Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Issue #12: add three TypeScript eval tasks where a change still parses but breaks types, and record a baseline of current Marv on them, so post-edit diagnostics (#13) can be measured against it.

**Architecture:** A task whose `repo/` has a `tsconfig.json` gets Marv's own TypeScript compiler copied into its temp workspace's `node_modules` (`evals/typescript.ts`, called from `workspace()` in `evals/run.ts`), so the hidden check, and the agent, can run `node_modules/.bin/tsc` in the sandbox without network. Each task's check runs its behavior tests plus `tsc --noEmit`. The runner also records whether the model ran a typecheck itself (`ranTypecheck`), which tells us how often diagnostics would add information.

**Tech Stack:** Bun (`bun test`, `Bun.spawnSync`), TypeScript 7 (`typescript` launcher plus the native `@typescript/typescript-<platform>` package), bubblewrap sandbox (`runCommand` in `src/tools/bash.ts`).

Spec: `docs/superpowers/specs/2026-10-08-post-edit-diagnostics-design.md`, section "Measuring". Branch: `post-edit-diagnostics`.

**Background for the engineer:**
- An eval task is a folder in `evals/tasks/<name>/`: `task.md` (the request sent to the model), `repo/` (starting files, committed into a fresh temp git repo per run), `check/__eval__.test.js` (hidden tests, copied in only after the run, run sandboxed as `bun test ./__eval__.test.js`), `solution/` (files layered over `repo/` that make the check pass). `bun run eval --verify` checks every task fails on `repo/` and passes on `repo/` + `solution/`.
- `bunfig.toml` limits `bun test` to `tests/`, so task test files never run as part of Marv's suite. The root `tsconfig.json` includes `evals/*.ts` (top level only), so files under `evals/tasks/` aren't part of `bun run typecheck`.
- `evals/tasks/**` is `-text` in `.gitattributes`: bytes are kept exactly. Write files with LF line endings.
- The sandbox hides the home folder, so a symlink from the temp repo into Marv's `node_modules` (under the home folder) would dangle inside it. That's why the compiler is copied (about 31 MB; a check of these tasks takes about 0.1 s with TypeScript 7).
- TypeScript 7's `node_modules/typescript/bin/tsc` is a `#!/usr/bin/env node` launcher that loads the native compiler from `node_modules/@typescript/typescript-<platform>`. Both folders must be copied. `/usr/bin/node` is visible in the sandbox (the system is mounted read-only).
- All three tasks were prototyped and verified before this plan was written: each `repo/` typechecks clean, each fails its check before any change and passes with its solution, and leaving one site unchanged is caught by tsc (`src/types.ts` in the rename, `src/guest.ts` in the required field, `src/log.ts` in make-async), by a runtime test (`src/banner.ts` and `src/keys.ts` in make-async: those still typecheck, since a template literal and `Object.keys` accept a `Promise`), or by both.

> **Superseded in part (2026-10-08):** code review changed Tasks 1–4 after they were written: `addTypeScript` throws when TypeScript is missing, replaces an existing link and dereferences, `ranTypecheck()` parses the bash command, `workspace()` excludes `node_modules/` via `.git/info/exclude` (commits 236b855, afa64cf); the tasks gained `typecheck` scripts, stderr in the tsc assertion, a hidden `@ts-expect-error` check that `email` is required (`ts-required-field`), a tsc-only caller `src/css.ts` (`ts-make-async`), clearer wording, and a recursive scan without the name in comments (`ts-rename-export`) (commit fe28829). The files in `evals/` are the source of truth; the listings below are the first version.

---

### Task 1: Copy TypeScript into TypeScript tasks' workspaces

**Files:**
- Create: `evals/typescript.ts`
- Create: `tests/eval-typescript.test.ts`
- Modify: `evals/run.ts` (`workspace()`, and the `tool_end` handler in `runOne()`)
- Modify: `evals/summary.ts` (`RunResult`)

- [ ] **Step 1: Write the failing test**

`tests/eval-typescript.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTypeScript } from "../evals/typescript.ts";

const temp = () => mkdtempSync(join(tmpdir(), "marv-eval-ts-"));

/** A stand-in for Marv's node_modules: the launcher, and (TypeScript 7) the native compiler package. */
function fakeModules({ native = true } = {}): string {
  const from = temp();
  mkdirSync(join(from, "typescript", "bin"), { recursive: true });
  writeFileSync(join(from, "typescript", "bin", "tsc"), "#!/usr/bin/env node\n");
  if (native) {
    mkdirSync(join(from, "@typescript", "typescript-linux-x64"), { recursive: true });
    writeFileSync(join(from, "@typescript", "typescript-linux-x64", "package.json"), "{}");
  }
  return from;
}

describe("addTypeScript", () => {
  test("copies the compiler into a project with a tsconfig.json, with .bin/tsc pointing at it", () => {
    const dir = temp();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(addTypeScript(dir, fakeModules())).toBe(true);
    expect(existsSync(join(dir, "node_modules", "typescript", "bin", "tsc"))).toBe(true);
    expect(existsSync(join(dir, "node_modules", "@typescript", "typescript-linux-x64", "package.json"))).toBe(true);
    // Relative, so it still resolves inside the sandbox, where the project is mounted at the same path.
    expect(readlinkSync(join(dir, "node_modules", ".bin", "tsc"))).toBe("../typescript/bin/tsc");
    expect(existsSync(join(dir, "node_modules", ".bin", "tsc"))).toBe(true);
  });

  test("works without the @typescript folder (TypeScript 5 has none)", () => {
    const dir = temp();
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(addTypeScript(dir, fakeModules({ native: false }))).toBe(true);
    expect(existsSync(join(dir, "node_modules", ".bin", "tsc"))).toBe(true);
    expect(existsSync(join(dir, "node_modules", "@typescript"))).toBe(false);
  });

  test("leaves a project without a tsconfig.json alone", () => {
    const dir = temp();
    expect(addTypeScript(dir, fakeModules())).toBe(false);
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test tests/eval-typescript`
Expected: FAIL, `Cannot find module '../evals/typescript.ts'`.

- [ ] **Step 3: Write the implementation**

`evals/typescript.ts`:

```ts
// A TypeScript task needs the compiler in its repo: its check runs `tsc --noEmit`, and the agent (and later Marv's
// post-edit check) finds it at node_modules/.bin/tsc, as in a real project. The runs have no network, so it's copied
// from Marv's own node_modules. Not symlinked: the sandbox hides the home folder such a link would point into.
import { cpSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const OWN = join(import.meta.dir, "..", "node_modules");

/** Copies TypeScript into `dir/node_modules` when `dir` has a tsconfig.json; says whether it did. */
export function addTypeScript(dir: string, from = OWN): boolean {
  if (!existsSync(join(dir, "tsconfig.json"))) return false;
  const modules = join(dir, "node_modules");
  // `typescript` is the launcher; from TypeScript 7 the compiler itself is a platform package under @typescript.
  for (const pkg of ["typescript", "@typescript"]) {
    if (existsSync(join(from, pkg))) cpSync(join(from, pkg), join(modules, pkg), { recursive: true });
  }
  mkdirSync(join(modules, ".bin"), { recursive: true });
  symlinkSync("../typescript/bin/tsc", join(modules, ".bin", "tsc"));
  return true;
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `bun test tests/eval-typescript`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Call it from `workspace()` in `evals/run.ts`**

Add the import next to the other local imports:

```ts
import { addTypeScript } from "./typescript.ts";
```

and at the end of `workspace()`, after the `start` commit (so the compiler is never part of the repo; the task repos' `.gitignore` lists `node_modules/`, so `git status` and the logged diff stay clean):

```ts
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  addTypeScript(dir);
  return dir;
```

- [ ] **Step 6: Record whether the model ran a typecheck itself**

In `evals/summary.ts`, add to `RunResult` after `syntaxNotes`:

```ts
  /** The model ran a typecheck itself: a bash command naming tsc or tsgo. */
  ranTypecheck?: boolean;
```

In `evals/run.ts`, in `runOne()`'s `tool_end` branch, after the `syntaxNotes` line:

```ts
          if (name === "bash" && /\b(tsc|tsgo)\b/.test(event.call.arguments)) result.ranTypecheck = true;
```

(`event.call.arguments` is the raw JSON text of the call, so the regex sees the command.)

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `bun run typecheck && bun test`
Expected: no type errors; all tests pass, 3 more than before this plan.

- [ ] **Step 8: Commit**

```bash
git add evals/typescript.ts evals/run.ts evals/summary.ts tests/eval-typescript.test.ts
git commit -m "Evals: copy TypeScript into a TypeScript task's workspace; record ranTypecheck, #12"
```

### Task 2: `ts-rename-export`

Rename an exported function. Two of its uses are easy to miss: `src/types.ts` refers to it only in a type (`typeof formatPrice`, invisible at runtime, so only tsc catches it), and `src/report.ts` uses it without calling it (a search for `formatPrice(` misses it). `src/report.ts` also imports it through the re-export in `src/index.ts`.

**Files:** create everything under `evals/tasks/ts-rename-export/`.

- [ ] **Step 1: The request**

`evals/tasks/ts-rename-export/task.md`:

```text
Rename formatPrice (in src/format.ts) to formatMoney everywhere. No formatPrice should be left anywhere in src/, including what src/index.ts exports.
```

- [ ] **Step 2: The starting repo** (it must typecheck clean: no errors before the model touches it)

`evals/tasks/ts-rename-export/repo/.gitignore`:

```text
node_modules/
```

`evals/tasks/ts-rename-export/repo/package.json`:

```json
{
  "name": "ts-rename-export",
  "private": true,
  "type": "module"
}
```

`evals/tasks/ts-rename-export/repo/src/cart.ts`:

```ts
import { formatPrice } from "./format.ts";

export interface Line {
  name: string;
  cents: number;
  qty: number;
}

export function cartTotal(lines: Line[], currency = "EUR"): string {
  return formatPrice(lines.reduce((sum, line) => sum + line.cents * line.qty, 0), currency);
}
```

`evals/tasks/ts-rename-export/repo/src/format.ts`:

```ts
/** An amount in cents as text: formatPrice(1999, "EUR") is "19.99 EUR". */
export function formatPrice(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
```

`evals/tasks/ts-rename-export/repo/src/index.ts`:

```ts
export { formatPrice } from "./format.ts";
export { cartTotal, type Line } from "./cart.ts";
```

`evals/tasks/ts-rename-export/repo/src/report.ts`:

```ts
import { formatPrice, type Line } from "./index.ts";
import type { Formatter } from "./types.ts";

const formatters: Record<string, Formatter> = {
  plain: formatPrice,
  short: (cents, currency) => `${Math.round(cents / 100)} ${currency}`,
};

export function report(lines: Line[], style = "plain"): string[] {
  const format = formatters[style] ?? formatPrice;
  return lines.map((line) => `${line.name}: ${format(line.cents * line.qty, "EUR")}`);
}
```

`evals/tasks/ts-rename-export/repo/src/types.ts`:

```ts
import type { formatPrice } from "./format.ts";

/** Anything that turns cents into text the way formatPrice does. */
export type Formatter = typeof formatPrice;
```

`evals/tasks/ts-rename-export/repo/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src"]
}
```
- [ ] **Step 3: The hidden check** (the last test runs the project's `tsc`; `include: ["src"]` keeps the check file itself out of it)

`evals/tasks/ts-rename-export/check/__eval__.test.js`:

```js
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as format from "./src/format.ts";
import * as index from "./src/index.ts";
import { cartTotal } from "./src/cart.ts";
import { report } from "./src/report.ts";

test("formatPrice is now formatMoney", () => {
  expect(format.formatMoney(1999, "EUR")).toBe("19.99 EUR");
  expect(format.formatPrice).toBeUndefined();
  expect(index.formatMoney).toBe(format.formatMoney);
  expect(index.formatPrice).toBeUndefined();
});
test("its users still work", () => {
  expect(cartTotal([{ name: "tea", cents: 250, qty: 2 }])).toBe("5.00 EUR");
  expect(report([{ name: "tea", cents: 300, qty: 1 }])).toEqual(["tea: 3.00 EUR"]);
  expect(report([{ name: "tea", cents: 349, qty: 1 }], "short")).toEqual(["tea: 3 EUR"]);
});
test("no formatPrice is left in src/", () => {
  for (const file of readdirSync("src")) expect(readFileSync(`src/${file}`, "utf8")).not.toContain("formatPrice");
});
test("it typechecks", () => {
  const tsc = Bun.spawnSync(["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json"]);
  expect(tsc.stdout.toString()).toBe("");
  expect(tsc.exitCode).toBe(0);
});
```
- [ ] **Step 4: The solution** (only the files that change)

`evals/tasks/ts-rename-export/solution/src/cart.ts`:

```ts
import { formatMoney } from "./format.ts";

export interface Line {
  name: string;
  cents: number;
  qty: number;
}

export function cartTotal(lines: Line[], currency = "EUR"): string {
  return formatMoney(lines.reduce((sum, line) => sum + line.cents * line.qty, 0), currency);
}
```

`evals/tasks/ts-rename-export/solution/src/format.ts`:

```ts
/** An amount in cents as text: formatMoney(1999, "EUR") is "19.99 EUR". */
export function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
```

`evals/tasks/ts-rename-export/solution/src/index.ts`:

```ts
export { formatMoney } from "./format.ts";
export { cartTotal, type Line } from "./cart.ts";
```

`evals/tasks/ts-rename-export/solution/src/report.ts`:

```ts
import { formatMoney, type Line } from "./index.ts";
import type { Formatter } from "./types.ts";

const formatters: Record<string, Formatter> = {
  plain: formatMoney,
  short: (cents, currency) => `${Math.round(cents / 100)} ${currency}`,
};

export function report(lines: Line[], style = "plain"): string[] {
  const format = formatters[style] ?? formatMoney;
  return lines.map((line) => `${line.name}: ${format(line.cents * line.qty, "EUR")}`);
}
```

`evals/tasks/ts-rename-export/solution/src/types.ts`:

```ts
import type { formatMoney } from "./format.ts";

/** Anything that turns cents into text the way formatMoney does. */
export type Formatter = typeof formatMoney;
```
- [ ] **Step 5: Verify it**

Run: `bun run eval --verify --tasks ts-rename-export`
Expected: `ok   ts-rename-export`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add evals/tasks/ts-rename-export
git commit -m "Evals: ts-rename-export task, #12"
```

### Task 3: `ts-required-field`

Add a required field to an interface. The object literals that need it don't all mention `User`: `src/guest.ts` passes a literal straight to `greet()` and keeps another in an untyped `const`, so searching for the interface's name doesn't find them; tsc does.

**Files:** create everything under `evals/tasks/ts-required-field/`.

- [ ] **Step 1: The request**

`evals/tasks/ts-required-field/task.md`:

```text
Add a required `email: string` field to the User interface in src/types.ts, and show it in greet: "Hi Ada Lovelace <ada@example.com>". makeUser (src/factory.ts) takes the email as a third argument. Wherever a user is created without a known address, use `<id>@example.com`.
```

- [ ] **Step 2: The starting repo** (it must typecheck clean: no errors before the model touches it)

`evals/tasks/ts-required-field/repo/.gitignore`:

```text
node_modules/
```

`evals/tasks/ts-required-field/repo/package.json`:

```json
{
  "name": "ts-required-field",
  "private": true,
  "type": "module"
}
```

`evals/tasks/ts-required-field/repo/src/csv.ts`:

```ts
import { makeUser } from "./factory.ts";
import type { User } from "./types.ts";

/** "id,name" lines to users. */
export function importUsers(csv: string): User[] {
  return csv
    .trim()
    .split("\n")
    .map((line) => {
      const [id = "", name = ""] = line.split(",");
      return makeUser(id, name);
    });
}
```

`evals/tasks/ts-required-field/repo/src/factory.ts`:

```ts
import type { User } from "./types.ts";

export function makeUser(id: string, name: string): User {
  return { id, name };
}
```

`evals/tasks/ts-required-field/repo/src/greet.ts`:

```ts
import type { User } from "./types.ts";

export const greet = (user: User): string => `Hi ${user.name}`;
```

`evals/tasks/ts-required-field/repo/src/guest.ts`:

```ts
import { greet } from "./greet.ts";

const owner = { id: "root", name: "Root" };

export const welcomeGuest = (): string => greet({ id: "guest", name: "Guest" });
export const welcomeOwner = (): string => greet(owner);
```

`evals/tasks/ts-required-field/repo/src/seed.ts`:

```ts
import type { User } from "./types.ts";

export const seed: User[] = [
  { id: "ada", name: "Ada Lovelace" },
  { id: "alan", name: "Alan Turing" },
];
```

`evals/tasks/ts-required-field/repo/src/types.ts`:

```ts
export interface User {
  id: string;
  name: string;
}
```

`evals/tasks/ts-required-field/repo/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src"]
}
```
- [ ] **Step 3: The hidden check** (the last test runs the project's `tsc`; `include: ["src"]` keeps the check file itself out of it)

`evals/tasks/ts-required-field/check/__eval__.test.js`:

```js
import { expect, test } from "bun:test";
import { makeUser } from "./src/factory.ts";
import { seed } from "./src/seed.ts";
import { greet } from "./src/greet.ts";
import { welcomeGuest, welcomeOwner } from "./src/guest.ts";
import { importUsers } from "./src/csv.ts";

test("makeUser takes the email", () => {
  expect(makeUser("lin", "Lin", "lin@x.io")).toEqual({ id: "lin", name: "Lin", email: "lin@x.io" });
});
test("greet shows it", () => {
  expect(greet({ id: "ada", name: "Ada Lovelace", email: "ada@example.com" })).toBe("Hi Ada Lovelace <ada@example.com>");
});
test("every user gets one", () => {
  for (const user of seed) expect(user.email).toBe(`${user.id}@example.com`);
  expect(importUsers("a,A\nb,B").map((user) => user.email)).toEqual(["a@example.com", "b@example.com"]);
  expect(welcomeGuest()).toBe("Hi Guest <guest@example.com>");
  expect(welcomeOwner()).toBe("Hi Root <root@example.com>");
});
test("it typechecks", () => {
  const tsc = Bun.spawnSync(["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json"]);
  expect(tsc.stdout.toString()).toBe("");
  expect(tsc.exitCode).toBe(0);
});
```
- [ ] **Step 4: The solution** (only the files that change)

`evals/tasks/ts-required-field/solution/src/csv.ts`:

```ts
import { makeUser } from "./factory.ts";
import type { User } from "./types.ts";

/** "id,name" lines to users. */
export function importUsers(csv: string): User[] {
  return csv
    .trim()
    .split("\n")
    .map((line) => {
      const [id = "", name = ""] = line.split(",");
      return makeUser(id, name, `${id}@example.com`);
    });
}
```

`evals/tasks/ts-required-field/solution/src/factory.ts`:

```ts
import type { User } from "./types.ts";

export function makeUser(id: string, name: string, email: string): User {
  return { id, name, email };
}
```

`evals/tasks/ts-required-field/solution/src/greet.ts`:

```ts
import type { User } from "./types.ts";

export const greet = (user: User): string => `Hi ${user.name} <${user.email}>`;
```

`evals/tasks/ts-required-field/solution/src/guest.ts`:

```ts
import { greet } from "./greet.ts";

const owner = { id: "root", name: "Root", email: "root@example.com" };

export const welcomeGuest = (): string => greet({ id: "guest", name: "Guest", email: "guest@example.com" });
export const welcomeOwner = (): string => greet(owner);
```

`evals/tasks/ts-required-field/solution/src/seed.ts`:

```ts
import type { User } from "./types.ts";

export const seed: User[] = [
  { id: "ada", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "alan", name: "Alan Turing", email: "alan@example.com" },
];
```

`evals/tasks/ts-required-field/solution/src/types.ts`:

```ts
export interface User {
  id: string;
  name: string;
  email: string;
}
```
- [ ] **Step 5: Verify it**

Run: `bun run eval --verify --tasks ts-required-field`
Expected: `ok   ts-required-field`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add evals/tasks/ts-required-field
git commit -m "Evals: ts-required-field task, #12"
```

### Task 4: `ts-make-async`

Make a function async. Its callers break in two ways: `src/theme.ts` and `src/log.ts` read a property off the `Promise` (tsc catches those), while `src/banner.ts` (a template literal) and `src/keys.ts` (`Object.keys`) still typecheck but give wrong results (only running the code catches those). That mix is deliberate: it shows what a typecheck can and can't catch.

**Files:** create everything under `evals/tasks/ts-make-async/`.

- [ ] **Step 1: The request**

`evals/tasks/ts-make-async/task.md`:

```text
readSync in src/store.ts is going away: make loadSettings (src/settings.ts) use the async read() instead, so loadSettings becomes async, delete readSync, and update everything that uses loadSettings so it still works.
```

- [ ] **Step 2: The starting repo** (it must typecheck clean: no errors before the model touches it)

`evals/tasks/ts-make-async/repo/.gitignore`:

```text
node_modules/
```

`evals/tasks/ts-make-async/repo/package.json`:

```json
{
  "name": "ts-make-async",
  "private": true,
  "type": "module"
}
```

`evals/tasks/ts-make-async/repo/src/banner.ts`:

```ts
import { theme } from "./theme.ts";

export function banner(): string {
  return `Theme: ${theme()}`;
}
```

`evals/tasks/ts-make-async/repo/src/keys.ts`:

```ts
import { loadSettings } from "./settings.ts";

/** The names of all settings, sorted. */
export function settingNames(): string[] {
  return Object.keys(loadSettings()).sort();
}
```

`evals/tasks/ts-make-async/repo/src/log.ts`:

```ts
import { loadSettings } from "./settings.ts";

/** The message as a debug line, or null when verbose is off. */
export function debug(message: string): string | null {
  return loadSettings().verbose ? `[debug] ${message}` : null;
}
```

`evals/tasks/ts-make-async/repo/src/settings.ts`:

```ts
import { readSync } from "./store.ts";

export interface Settings {
  theme: "light" | "dark";
  verbose: boolean;
}

const DEFAULTS: Settings = { theme: "light", verbose: false };

export function loadSettings(): Settings {
  const raw = readSync("settings");
  return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
}
```

`evals/tasks/ts-make-async/repo/src/store.ts`:

```ts
// A pretend key-value store. read() is the real API; readSync() is left over from before it.
const data = new Map<string, string>([["settings", JSON.stringify({ theme: "dark", verbose: true })]]);

export async function read(key: string): Promise<string | undefined> {
  await Promise.resolve(); // a real store would wait for the disk or the network here
  return data.get(key);
}

export function readSync(key: string): string | undefined {
  return data.get(key);
}
```

`evals/tasks/ts-make-async/repo/src/theme.ts`:

```ts
import { loadSettings, type Settings } from "./settings.ts";

export function theme(): Settings["theme"] {
  return loadSettings().theme;
}
```

`evals/tasks/ts-make-async/repo/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["src"]
}
```
- [ ] **Step 3: The hidden check** (the last test runs the project's `tsc`; `include: ["src"]` keeps the check file itself out of it)

`evals/tasks/ts-make-async/check/__eval__.test.js`:

```js
import { expect, test } from "bun:test";
import * as store from "./src/store.ts";
import { loadSettings } from "./src/settings.ts";
import { theme } from "./src/theme.ts";
import { banner } from "./src/banner.ts";
import { debug } from "./src/log.ts";
import { settingNames } from "./src/keys.ts";

test("loadSettings is async, and readSync is gone", async () => {
  const settings = loadSettings();
  expect(settings).toBeInstanceOf(Promise);
  expect(await settings).toEqual({ theme: "dark", verbose: true });
  expect(store.readSync).toBeUndefined();
});
test("everything that uses it still works", async () => {
  expect(await theme()).toBe("dark");
  expect(await banner()).toBe("Theme: dark");
  expect(await debug("hi")).toBe("[debug] hi");
  expect(await settingNames()).toEqual(["theme", "verbose"]);
});
test("it typechecks", () => {
  const tsc = Bun.spawnSync(["node_modules/.bin/tsc", "--noEmit", "--pretty", "false", "-p", "tsconfig.json"]);
  expect(tsc.stdout.toString()).toBe("");
  expect(tsc.exitCode).toBe(0);
});
```
- [ ] **Step 4: The solution** (only the files that change)

`evals/tasks/ts-make-async/solution/src/banner.ts`:

```ts
import { theme } from "./theme.ts";

export async function banner(): Promise<string> {
  return `Theme: ${await theme()}`;
}
```

`evals/tasks/ts-make-async/solution/src/keys.ts`:

```ts
import { loadSettings } from "./settings.ts";

/** The names of all settings, sorted. */
export async function settingNames(): Promise<string[]> {
  return Object.keys(await loadSettings()).sort();
}
```

`evals/tasks/ts-make-async/solution/src/log.ts`:

```ts
import { loadSettings } from "./settings.ts";

/** The message as a debug line, or null when verbose is off. */
export async function debug(message: string): Promise<string | null> {
  return (await loadSettings()).verbose ? `[debug] ${message}` : null;
}
```

`evals/tasks/ts-make-async/solution/src/settings.ts`:

```ts
import { read } from "./store.ts";

export interface Settings {
  theme: "light" | "dark";
  verbose: boolean;
}

const DEFAULTS: Settings = { theme: "light", verbose: false };

export async function loadSettings(): Promise<Settings> {
  const raw = await read("settings");
  return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) };
}
```

`evals/tasks/ts-make-async/solution/src/store.ts`:

```ts
// A pretend key-value store.
const data = new Map<string, string>([["settings", JSON.stringify({ theme: "dark", verbose: true })]]);

export async function read(key: string): Promise<string | undefined> {
  await Promise.resolve(); // a real store would wait for the disk or the network here
  return data.get(key);
}
```

`evals/tasks/ts-make-async/solution/src/theme.ts`:

```ts
import { loadSettings, type Settings } from "./settings.ts";

export async function theme(): Promise<Settings["theme"]> {
  return (await loadSettings()).theme;
}
```
- [ ] **Step 5: Verify it**

Run: `bun run eval --verify --tasks ts-make-async`
Expected: `ok   ts-make-async`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add evals/tasks/ts-make-async
git commit -m "Evals: ts-make-async task, #12"
```

### Task 5: Verify everything and document it

**Files:**
- Modify: `CLAUDE.md` (the **Evals** bullet)

- [ ] **Step 1: Verify all 13 tasks**

Run: `bun run eval --verify`
Expected: 13 lines starting `ok`, exit 0. The 10 JavaScript tasks have no `tsconfig.json`, so nothing changes for them.

- [ ] **Step 2: Document it in `CLAUDE.md`**

In the **Evals (`evals/`)** bullet, after the sentence ending "`solution/` (for `--verify`, which checks every task fails before and passes with its solution; run it after changing a task).", add:

```markdown
A task whose `repo/` has a `tsconfig.json` gets Marv's own TypeScript (`typescript` plus the native `@typescript/*` package) copied into its workspace's `node_modules` after the start commit (`evals/typescript.ts`; copied, not linked, since the sandbox hides the home folder), so its check, and the agent, can run `node_modules/.bin/tsc` offline; the `ts-*` tasks' checks run their tests plus `tsc --noEmit`, and `RunResult.ranTypecheck` says whether the model ran a typecheck itself.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md: TypeScript eval tasks, #12"
```

### Task 6: Record the baseline (spends money: ask the user first)

This calls real models through OpenRouter: about 45 runs, roughly $0.15 at the 2026-10-06 rates. Don't start it without the user's go-ahead.

- [ ] **Step 1: Run current Marv on the TypeScript tasks**

The five models that gave signal on 2026-10-06 (mistral-nemo was too weak to tell anything), 3 repetitions each:

```bash
bun run eval --models deepseek/deepseek-v4-flash,openai/gpt-5-nano,openai/gpt-oss-120b,qwen/qwen3.7-flash,z-ai/glm-5.3-flash \
  --tasks ts-rename-export,ts-required-field,ts-make-async --repeat 3 --label ts-baseline --budget 0.5
```

Expected: `45 runs (5 models × 3 tasks × 3)`, then a summary table; results in `evals/results/<stamp>-ts-baseline/results.jsonl`.

- [ ] **Step 2: How often did the model typecheck by itself?**

```bash
jq -r '[.model, .task, .pass, (.ranTypecheck // false)] | @tsv' evals/results/*-ts-baseline/results.jsonl | sort | uniq -c
```

- [ ] **Step 3: Read a few failures**

For two or three failed runs, open `evals/results/<stamp>-ts-baseline/logs/<model>/<task>-<rep>.json` and note what was missed: a site tsc would have caught (what #13 can fix) or one only the tests catch (what it can't).

- [ ] **Step 4: Post the results on #12, then close it**

Comment on #12 with: the summary table, per-task pass rates, how often `ranTypecheck` was true, and the failure notes. Say that #13 compares against this label (`ts-baseline`) and must rerun it the same day, since the providers behind a model id change. Close #12 with the comment.

```bash
gh issue comment 12 -F <notes-file>
gh issue close 12
```
