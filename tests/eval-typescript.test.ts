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
