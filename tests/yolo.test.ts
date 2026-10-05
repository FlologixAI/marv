import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCall } from "../src/provider/types.ts";
import { sandboxAvailable } from "../src/sandbox.ts";
import { runTool } from "../src/tools/index.ts";
import type { ApprovalRequest, ToolContext } from "../src/tools/types.ts";

// Yolo mode: calls whose effects the sandbox (or the project folder) confines
// run without asking; everything else still asks.

let root: string;
let asked: ApprovalRequest[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-yolo-"));
  await mkdir(join(root, ".git", "hooks"), { recursive: true });
  await writeFile(join(root, ".git", "config"), "[core]\n");
  await writeFile(join(root, "a.txt"), "one\n");
  asked = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let nextId = 0;
const call = (name: string, args: unknown): ToolCall => ({ id: `y${nextId++}`, name, arguments: JSON.stringify(args) });
const run = (name: string, args: unknown, ctx: Partial<ToolContext> = {}) =>
  runTool(call(name, args), {
    root,
    sandbox: true,
    yolo: true,
    approve: async (request) => {
      asked.push(request);
      return "yes";
    },
    ...ctx,
  });

describe("file changes", () => {
  test("an edit inside the project runs without asking", async () => {
    const result = await run("edit_file", { path: "a.txt", old_string: "one", new_string: "two" });
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("two\n");
    expect(asked).toHaveLength(0);
  });

  test("without yolo, it asks as before", async () => {
    await run("write_file", { path: "b.txt", content: "b" }, { yolo: false });
    expect(asked).toHaveLength(1);
  });

  test("a change inside .git asks (hooks and config run outside the sandbox)", async () => {
    await run("write_file", { path: ".git/hooks/pre-commit", content: "evil" });
    await run("edit_file", { path: ".git/config", old_string: "[core]", new_string: "[core]\nx = 1" });
    expect(asked.map((r) => r.tool)).toEqual(["write_file", "edit_file"]);
  });

  test("so does one through a symlink that leads into .git", async () => {
    await symlink(join(root, ".git", "hooks"), join(root, "hooks"));
    await run("write_file", { path: "hooks/post-checkout", content: "evil" });
    expect(asked).toHaveLength(1);
  });

  test("a call that can't succeed still fails before anything runs", async () => {
    const result = await run("edit_file", { path: "a.txt", old_string: "missing", new_string: "x" });
    expect(result.isError).toBe(true);
    expect(asked).toHaveLength(0);
  });
});

test("memory changes always ask: they come back in every session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "marv-yolo-mem-"));
  try {
    await run("memory", { action: "add", scope: "personal", text: "likes tabs" }, { memory: { personal: join(dir, "p.md"), project: join(dir, "x.md") } });
    expect(asked.map((r) => r.tool)).toEqual(["memory"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("bash", () => {
  test("with the sandbox off, commands ask", async () => {
    await run("bash", { command: "echo hi" }, { sandbox: false });
    expect(asked).toHaveLength(1);
  });

  test("git_write has its own 'don't ask again' scope", async () => {
    await run("bash", { command: "git commit -m x", git_write: true }, { yolo: false, sandbox: false });
    expect(asked[0]!.scope.key).toBe("bash:git:git commit -m x");
  });

  describe.if(sandboxAvailable())("in the sandbox", () => {
    test("a command runs without asking", async () => {
      const result = await run("bash", { command: "echo hi > b.txt && cat b.txt" });
      expect(result.output).toContain("hi");
      expect(asked).toHaveLength(0);
    });

    test("network and git_write still ask", async () => {
      await run("bash", { command: "true", network: true });
      await run("bash", { command: "true", git_write: true });
      expect(asked.map((r) => r.preview.command)).toEqual(["true", "true"]);
      expect(asked[0]!.network).toBe(true);
    });

    test("a command that runs without asking can't change .git, and is told how to", async () => {
      const result = await run("bash", { command: "echo evil > .git/hooks/pre-commit" });
      expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(result.output).toContain("Read-only file system");
      expect(result.output).toContain("git_write: true");
    });

    test("an approved git_write command can", async () => {
      await run("bash", { command: "echo ok > .git/hooks/x", git_write: true });
      expect(asked).toHaveLength(1);
      expect(existsSync(join(root, ".git", "hooks", "x"))).toBe(true);
    });

    test("without yolo, an approved command can change .git as before", async () => {
      await run("bash", { command: "echo ok > .git/description" }, { yolo: false });
      expect(asked).toHaveLength(1);
      expect(await readFile(join(root, ".git", "description"), "utf8")).toBe("ok\n");
    });

    test("in a project without .git, commands still run", async () => {
      await rm(join(root, ".git"), { recursive: true });
      expect((await run("bash", { command: "echo fine" })).output).toContain("fine");
      expect(asked).toHaveLength(0);
    });
  });
});
