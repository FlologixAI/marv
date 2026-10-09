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
