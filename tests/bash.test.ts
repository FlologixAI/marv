import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { formatOutput, runCommand } from "../src/tools/bash.ts";
import { sandboxArgs, sandboxAvailable } from "../src/sandbox.ts";

describe("sandboxArgs", () => {
  const base = { root: "/home/me/proj", home: "/home/me", path: "/usr/bin", exists: (p: string) => p.endsWith(".bun") };

  describe("extra read-only folders", () => {
    let tmp: string;
    let home: string;
    let root: string;
    let git: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "marv-extra-"));
      home = join(tmp, "home");
      root = join(home, "proj");
      git = join(tmp, "repo", ".git");
      mkdirSync(root, { recursive: true });
      mkdirSync(git, { recursive: true });
    });
    afterEach(() => rmSync(tmp, { recursive: true, force: true }));
    const args = (readOnly: string[]) => sandboxArgs({ root, home, path: "/usr/bin", network: false, readOnly });

    test("(a worktree's shared .git) are mounted after the home is hidden and the root bound", () => {
      const a = args([git]);
      expect(a.join(" ")).toContain(`--ro-bind ${git} ${git}`);
      const at = a.lastIndexOf(git);
      expect(at).toBeGreaterThan(a.indexOf(home)); // after the home tmpfs
      expect(at).toBeGreaterThan(a.indexOf(root)); // after the root bind
    });

    test("never add a read-write bind", () => {
      const a = args([git]);
      // Only the project is writable.
      const writable = a.flatMap((x, i) => (x === "--bind" ? [a[i + 1]] : []));
      expect(writable).toEqual([root]);
    });

    test("that would expose the home folder or the whole system are refused", () => {
      for (const dir of ["/", tmp, home, "relative"]) expect(() => args([dir])).toThrow();
    });

    test("that are symlinks to the home folder are refused, and others are bound by their real path", () => {
      const link = join(tmp, "link");
      symlinkSync(home, link);
      expect(() => args([link])).toThrow();
      const alias = join(tmp, "alias");
      symlinkSync(git, alias);
      const a = args([alias]);
      const real = realpathSync(git);
      expect(a.join(" ")).toContain(`--ro-bind ${real} ${alias}`);
    });

    test("that equal the project or contain it are refused", () => {
      expect(() => args([root])).toThrow();
      expect(() => args([home])).toThrow();
      const inner = join(root, "sub");
      mkdirSync(inner);
      expect(args([inner]).join(" ")).toContain(`--ro-bind ${realpathSync(inner)} ${inner}`); // inside the project is fine
    });

    test("that are missing fail and name the folder", () => {
      expect(() => args([join(tmp, "nope")])).toThrow(/nope/);
    });
  });

  test("read-only system, hidden home, writable project, no network, clean env", () => {
    const args = sandboxArgs({ ...base, network: false }).join(" ");
    expect(args).toContain("--ro-bind / /");
    expect(args).toContain("--tmpfs /home/me"); // home hidden…
    expect(args).toContain("--ro-bind /home/me/.bun /home/me/.bun"); // …except toolchains, read-only
    expect(args).not.toContain(".cargo"); // only the ones that exist
    expect(args).toContain("--bind /home/me/proj /home/me/proj");
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--clearenv");
    expect(args).toContain("--chdir /home/me/proj");
  });

  test("personal skills are readable, the rest of ~/.marv is not", () => {
    const args = sandboxArgs({ ...base, network: false, exists: (p) => p.endsWith(".marv/skills") }).join(" ");
    expect(args).toContain("--ro-bind /home/me/.marv/skills /home/me/.marv/skills");
    expect(args).not.toContain("/home/me/.marv /home/me/.marv");
  });

  test("network can be allowed per command", () => {
    expect(sandboxArgs({ ...base, network: true })).not.toContain("--unshare-net");
  });

  test("bun's cache is a throwaway one in the private /tmp, never the user's (network or not)", () => {
    const exists = (p: string) => p.endsWith(".bun") || p.endsWith(".bun/install/cache");
    for (const network of [false, true]) {
      const args = sandboxArgs({ ...base, exists, network }).join(" ");
      expect(args).toContain("--setenv BUN_INSTALL_CACHE_DIR /tmp/bun-cache");
      // A shared or host cache would let one sandboxed command plant packages for another context.
      expect(args).not.toContain("--bind /home/me/.bun/install/cache");
      expect(args).not.toContain("sandbox-cache");
    }
  });

  test("credential files inside the read-only toolchain folders are hidden", () => {
    const secrets = ["/home/me/.cargo/credentials", "/home/me/.cargo/credentials.toml", "/home/me/.config/git/credentials"];
    const exists = (p: string) => [".cargo", ".config/git"].some((dir) => p.endsWith(dir)) || secrets.includes(p);
    const args = sandboxArgs({ ...base, exists, network: false });
    const joined = args.join(" ");
    for (const secret of secrets) {
      expect(joined).toContain(`--ro-bind /dev/null ${secret}`);
      // After the toolchain mounts, so /dev/null sits on top of the real file.
      expect(args.lastIndexOf(secret)).toBeGreaterThan(Math.max(args.lastIndexOf("/home/me/.cargo"), args.lastIndexOf("/home/me/.config/git")));
    }
    // Ones that don't exist aren't mounted (bwrap would have to create them).
    expect(sandboxArgs({ ...base, exists: (p) => p.endsWith(".cargo"), network: false }).join(" ")).not.toContain("/dev/null /home/me");
  });

  test("the project is mounted after the home folder is hidden (so it stays visible)", () => {
    const args = sandboxArgs({ ...base, network: false });
    expect(args.indexOf("/home/me/proj")).toBeGreaterThan(args.indexOf("--tmpfs", args.indexOf("/tmp") + 1));
  });
});

describe("runCommand", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "marv-bash-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const run = (command: string, extra: Partial<Parameters<typeof runCommand>[0]> = {}) =>
    runCommand({ command, root, sandbox: false, network: false, timeoutMs: 10_000, ...extra });

  test("returns combined output and the exit code", async () => {
    const result = await run("echo out; echo err >&2; exit 3");
    expect(result.output).toBe("out\nerr\n");
    expect(result.exitCode).toBe(3);
  });

  test("runs in the project folder", async () => {
    await writeFile(join(root, "hello.txt"), "hi");
    expect((await run("cat hello.txt")).output).toBe("hi");
  });

  test("kills commands that run too long", async () => {
    const result = await run("sleep 5; echo never", { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.output).not.toContain("never");
  });

  test("stops when aborted (ctrl+c)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await run("sleep 5", { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.aborted).toBe(true);
  });

  test("doesn't pass API keys through to the command", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-secret";
    try {
      expect((await run("echo key=$OPENROUTER_API_KEY")).output).toBe("key=\n");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  describe.if(sandboxAvailable())("inside the bubblewrap sandbox", () => {
    const sandboxed = (command: string, network = false) => run(command, { sandbox: true, network });

    test("can write the project, but not the system", async () => {
      expect((await sandboxed("touch made-it && ls made-it")).output).toBe("made-it\n");
      const system = await sandboxed("touch /usr/marv-probe");
      expect(system.exitCode).not.toBe(0);
    });

    test("can't see the home folder (keys, ssh, Marv's config)", async () => {
      const result = await sandboxed(`ls -A ${homedir()}/.ssh ${homedir()}/.marv 2>&1; echo done`);
      expect(result.output).toContain("No such file");
      expect(result.output).not.toContain("config.json");
    });

    test("has no network unless asked", async () => {
      const offline = await sandboxed("bun -e 'await fetch(\"http://1.1.1.1\", { signal: AbortSignal.timeout(2000) })' 2>&1; echo exit=$?");
      expect(offline.output).toMatch(/exit=[1-9]/);
    });
  });
});

describe("formatOutput", () => {
  test("shows the command's output and exit code", () => {
    expect(formatOutput({ output: "ok\n", exitCode: 0, timedOut: false, aborted: false })).toBe("ok\n\n[exit code 0]");
    expect(formatOutput({ output: "", exitCode: 1, timedOut: false, aborted: false })).toBe("(no output)\n\n[exit code 1]");
  });

  test("keeps the start and the end of very long output", () => {
    const output = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const text = formatOutput({ output, exitCode: 0, timedOut: false, aborted: false });
    expect(text.length).toBeLessThan(32_000);
    expect(text).toContain("line 0\n");
    expect(text).toContain("line 4999");
    expect(text).toMatch(/characters omitted/);
  });

  test("says when it timed out", () => {
    expect(formatOutput({ output: "partial", exitCode: null, timedOut: true, aborted: false, timeoutMs: 1000 })).toContain("[timed out after 1s]");
  });
});
