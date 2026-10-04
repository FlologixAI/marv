import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../src/tools/index.ts";
import type { ApprovalRequest, Decision } from "../src/tools/types.ts";
import type { ToolCall } from "../src/provider/types.ts";

let root: string;
let outside: string;
let asked: ApprovalRequest[];
let answer: Decision;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-write-"));
  outside = await mkdtemp(join(tmpdir(), "marv-outside-"));
  await writeFile(join(root, "greet.ts"), "export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n");
  await writeFile(join(root, "twice.ts"), "x = 1;\nx = 1;\n");
  asked = [];
  answer = "yes";
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

let nextId = 0;
const call = (name: string, args: unknown): ToolCall => ({ id: `c${nextId++}`, name, arguments: JSON.stringify(args) });
const run = (name: string, args: unknown) =>
  runTool(call(name, args), {
    root,
    sandbox: false,
    approve: async (request) => {
      asked.push(request);
      return answer;
    },
  });
const read = (path: string) => readFile(join(root, path), "utf8");

describe("edit_file", () => {
  test("replaces exactly one match, after showing the diff for approval", async () => {
    const result = await run("edit_file", { path: "greet.ts", old_string: "Hello", new_string: "Hi" });
    expect(result.isError).toBeFalsy();
    expect(await read("greet.ts")).toContain("`Hi, ${name}!`");
    expect(result.summary).toBe("+1 −1");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.preview.title).toBe("Edit greet.ts");
    expect(asked[0]!.preview.diff).toContainEqual({ kind: "del", text: "  return `Hello, ${name}!`;" });
    expect(asked[0]!.preview.diff).toContainEqual({ kind: "add", text: "  return `Hi, ${name}!`;" });
  });

  test("doesn't ask when the text isn't there, and tells the model how to fix it", async () => {
    const result = await run("edit_file", { path: "greet.ts", old_string: "Goodbye", new_string: "x" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("not found");
    expect(result.output).toContain("read_file"); // tells the model how to recover
    expect(asked).toHaveLength(0);
  });

  test("refuses an ambiguous match unless replace_all is set", async () => {
    const ambiguous = await run("edit_file", { path: "twice.ts", old_string: "x = 1;", new_string: "x = 2;" });
    expect(ambiguous).toMatchObject({ isError: true, output: expect.stringContaining("2 times") });
    expect(asked).toHaveLength(0);

    const all = await run("edit_file", { path: "twice.ts", old_string: "x = 1;", new_string: "x = 2;", replace_all: true });
    expect(all.isError).toBeFalsy();
    expect(await read("twice.ts")).toBe("x = 2;\nx = 2;\n");
  });

  test("a declined edit changes nothing", async () => {
    answer = "no";
    const result = await run("edit_file", { path: "greet.ts", old_string: "Hello", new_string: "Hi" });
    expect(result).toMatchObject({ declined: true, summary: "declined" });
    expect(await read("greet.ts")).toContain("Hello");
  });

  test("all file changes share one 'don't ask again' scope", async () => {
    await run("edit_file", { path: "greet.ts", old_string: "Hello", new_string: "Hi" });
    await run("write_file", { path: "new.ts", content: "x" });
    expect(asked.map((r) => r.scope.key)).toEqual(["files", "files"]);
  });
});

describe("write_file", () => {
  test("creates a new file, and its folders", async () => {
    const result = await run("write_file", { path: "src/deep/new.ts", content: "export const a = 1;\n" });
    expect(result.isError).toBeFalsy();
    expect(await read("src/deep/new.ts")).toBe("export const a = 1;\n");
    expect(result.summary).toBe("created · 1 line");
    expect(asked[0]!.preview.title).toBe("Create src/deep/new.ts");
  });

  test("an absolute path inside the project is shown relative to it", async () => {
    const result = await run("write_file", { path: join(root, "abs.ts"), content: "x" });
    expect(result.label).toBe("abs.ts");
    expect(asked[0]!.label).toBe("abs.ts");
  });

  test("overwriting shows what changes", async () => {
    await run("write_file", { path: "greet.ts", content: "export const greet = () => 'hi';\n" });
    expect(asked[0]!.preview.title).toBe("Overwrite greet.ts");
    expect(asked[0]!.preview.diff!.some((l) => l.kind === "del")).toBe(true);
  });

  test.each([
    ["../escape.ts", "outside the project"],
    ["/tmp/escape.ts", "outside the project"],
  ])("refuses %s", async (path, message) => {
    const result = await run("write_file", { path, content: "x" });
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining(message) });
    expect(asked).toHaveLength(0);
  });

  test("can't escape through a symlinked folder, even to create a new file", async () => {
    await symlink(outside, join(root, "linked"));
    const result = await run("write_file", { path: "linked/escape.ts", content: "x" });
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining("outside the project") });
    expect(existsSync(join(outside, "escape.ts"))).toBe(false);
  });
});

describe("approval", () => {
  test("read-only tools never ask", async () => {
    await run("read_file", { path: "greet.ts" });
    await run("grep", { pattern: "greet" });
    expect(asked).toHaveLength(0);
  });

  test("bash asks, shows the command, and scopes 'don't ask again' to that exact command", async () => {
    const result = await run("bash", { command: "echo hi" });
    expect(result.output).toContain("hi");
    expect(asked[0]!.preview.text).toBe("echo hi");
    expect(asked[0]!.scope).toEqual({ key: "bash:echo hi", description: "this exact command" });
  });

  test("without an approver, changes are refused", async () => {
    const result = await runTool(call("write_file", { path: "x.ts", content: "x" }), { root });
    expect(result.isError).toBe(true);
    expect(existsSync(join(root, "x.ts"))).toBe(false);
  });
});

test("a folder in the way is reported, not overwritten", async () => {
  await mkdir(join(root, "dir"));
  const result = await run("write_file", { path: "dir", content: "x" });
  expect(result).toMatchObject({ isError: true, output: expect.stringContaining("is a directory") });
});
