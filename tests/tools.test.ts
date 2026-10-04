import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool, toolSpecs } from "../src/tools/index.ts";
import type { ToolCall } from "../src/provider/types.ts";

let root: string;
let outside: string;

async function files(tree: Record<string, string | Buffer>) {
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-tools-"));
  outside = await mkdtemp(join(tmpdir(), "marv-outside-"));
  await files({
    "package.json": '{ "name": "demo" }\n',
    "src/app.ts": "export function main() {\n  return greet('world');\n}\n",
    "src/greet.ts": "export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n",
    "src/ui/view.tsx": "// TODO: render the greeting\nexport const View = () => null;\n",
    "node_modules/dep/index.js": "function greet() {}\n",
    "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]),
  });
  await writeFile(join(outside, "secret.txt"), "top secret\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

let nextId = 0;
const call = (name: string, args: unknown): ToolCall => ({ id: `call_${nextId++}`, name, arguments: JSON.stringify(args) });
const run = (name: string, args: unknown) => runTool(call(name, args), { root });

describe("read_file", () => {
  test("returns numbered lines and a summary", async () => {
    const result = await run("read_file", { path: "src/greet.ts" });
    expect(result.isError).toBeFalsy();
    expect(result.output).toBe("    1\texport function greet(name: string) {\n    2\t  return `Hello, ${name}!`;\n    3\t}");
    expect(result.summary).toBe("3 lines");
    expect(result.label).toBe("src/greet.ts");
  });

  test("reads a slice with offset and limit, and says how to continue", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    await files({ "long.txt": lines });
    const result = await run("read_file", { path: "long.txt", offset: 10, limit: 3 });
    expect(result.output).toStartWith("   10\tline 10\n   11\tline 11\n   12\tline 12");
    expect(result.output).toContain("lines 10-12 of 50");
    expect(result.output).toContain("offset=13");
    expect(result.summary).toBe("lines 10-12 of 50");
  });

  test("accepts an absolute path inside the project", async () => {
    expect((await run("read_file", { path: join(root, "package.json") })).output).toContain('"demo"');
  });

  test.each([
    ["../outside.txt", "outside the project"],
    ["/etc/hostname", "outside the project"],
    ["missing.ts", "File not found: missing.ts"],
    ["src", "is a directory"],
  ])("refuses %s", async (path, message) => {
    const result = await run("read_file", { path });
    expect(result.isError).toBe(true);
    expect(result.output).toContain(message);
  });

  test("won't follow a symlink out of the project", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    const result = await run("read_file", { path: "link.txt" });
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain("top secret");
  });

  test("doesn't dump binary files", async () => {
    const result = await run("read_file", { path: "logo.png" });
    expect(result.output).toBe("Binary file (7 bytes), not shown.");
  });
});

describe("glob", () => {
  test("finds files by pattern, sorted, relative to the project", async () => {
    const result = await run("glob", { pattern: "**/*.ts" });
    expect(result.output).toBe("src/app.ts\nsrc/greet.ts");
    expect(result.summary).toBe("2 files");
  });

  test("searches inside a directory", async () => {
    expect((await run("glob", { pattern: "**/*", path: "src/ui" })).output).toBe("src/ui/view.tsx");
  });

  test("skips node_modules even outside git", async () => {
    expect((await run("glob", { pattern: "**/*.js" })).output).toBe("No files match.");
  });

  test("respects .gitignore inside a git repo", async () => {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    await files({ ".gitignore": "src/ui/\n" });
    expect((await run("glob", { pattern: "**/*.tsx" })).output).toBe("No files match.");
  });
});

describe("grep", () => {
  test("finds matching lines with file and line number", async () => {
    const result = await run("grep", { pattern: "greet\\(" });
    expect(result.output).toBe("src/app.ts:2:  return greet('world');\nsrc/greet.ts:1:export function greet(name: string) {");
    expect(result.summary).toBe("2 matches in 2 files");
  });

  test("filters files with a glob and can ignore case", async () => {
    const result = await run("grep", { pattern: "todo", glob: "*.tsx", ignoreCase: true });
    expect(result.output).toBe("src/ui/view.tsx:1:// TODO: render the greeting");
  });

  test("reports no matches and bad patterns clearly", async () => {
    expect((await run("grep", { pattern: "nothing-like-this" })).output).toBe("No matches.");
    const bad = await run("grep", { pattern: "(" });
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain("Invalid regex");
  });
});

describe("runTool", () => {
  test("rejects unknown tools, broken JSON, and invalid input, as results the model can read", async () => {
    expect((await run("delete_everything", {})).output).toContain("Unknown tool");
    const broken = await runTool({ id: "x", name: "read_file", arguments: "{not json" }, { root });
    expect(broken).toMatchObject({ isError: true, output: expect.stringContaining("not valid JSON") });
    const invalid = await run("read_file", { path: 42 });
    expect(invalid).toMatchObject({ isError: true, output: expect.stringContaining("path") });
  });
});

describe("toolSpecs", () => {
  test("describe every tool with a JSON schema, without the $schema noise", () => {
    expect(toolSpecs.map((t) => t.name)).toEqual(["read_file", "glob", "grep", "skill", "edit_file", "write_file", "bash"]);
    for (const spec of toolSpecs) {
      expect(spec.description.length).toBeGreaterThan(20);
      expect(spec.parameters).toMatchObject({ type: "object" });
      expect(spec.parameters).not.toHaveProperty("$schema");
    }
  });
});
