import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { fetchGithub, parseGithub, type GithubLink } from "../src/tools/web/github.ts";

const TREE = {
  tree: [
    { path: "README.md", type: "blob" },
    { path: "src", type: "tree" },
    { path: "src/server.js", type: "blob" },
    { path: "src/tools/chart.js", type: "blob" },
  ],
  truncated: false,
};
const raw = (body: string) => new Response(body, { headers: { "content-type": "application/vnd.github.raw; charset=utf-8" } });

let server: ReturnType<typeof Bun.serve>;
let base: string;
let seen: { path: string; auth: string | null; accept: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, auth: req.headers.get("authorization"), accept: req.headers.get("accept") });
      switch (url.pathname) {
        case "/repos/acme/tool": return Response.json({ full_name: "acme/tool", description: "A handy tool.", default_branch: "main", stargazers_count: 42, language: "JavaScript" });
        case "/repos/acme/tool/readme": return raw("# Tool\n\nRun `npm start`.\n");
        case "/repos/acme/tool/git/trees/main": return Response.json(TREE);
        case "/repos/acme/tool/contents/src/server.js": return raw("const a = 1;\nconst b = 2;\n");
        case "/raw/acme/tool/main/src/server.js": return new Response("const a = 1;\nconst b = 2;\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
        case "/repos/acme/big": return Response.json({ full_name: "acme/big", description: null, default_branch: "main" });
        case "/repos/acme/big/git/trees/main": return Response.json({ tree: Array.from({ length: 600 }, (_, i) => ({ path: `f${i}.txt`, type: "blob" })), truncated: false });
        case "/repos/acme/limited": return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791000000" } });
      }
      return new Response("{}", { status: 404, statusText: "Not Found" });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
});

const opts = (token = "") => ({ allowPrivate: true, allowHttp: true, apiBase: base, rawBase: `${base}/raw`, token });
const link = (url: string) => parseGithub(new URL(url))!;

describe("parseGithub", () => {
  test("repositories, folders and files", () => {
    expect(parseGithub(new URL("https://github.com/acme/tool"))).toEqual({ kind: "repo", owner: "acme", repo: "tool" });
    expect(parseGithub(new URL("https://www.github.com/acme/tool.git"))).toEqual({ kind: "repo", owner: "acme", repo: "tool" });
    expect(parseGithub(new URL("https://github.com/acme/tool/tree/main"))).toEqual({ kind: "tree", owner: "acme", repo: "tool", ref: "main", dir: "" });
    expect(parseGithub(new URL("https://github.com/acme/tool/tree/main/src/tools"))).toEqual({ kind: "tree", owner: "acme", repo: "tool", ref: "main", dir: "src/tools" });
    expect(parseGithub(new URL("https://github.com/acme/tool/blob/v2/src/a.ts"))).toEqual({ kind: "blob", owner: "acme", repo: "tool", ref: "v2", path: "src/a.ts" });
  });

  test("anything else is read as a web page", () => {
    for (const url of ["https://github.com/acme/tool/issues/3", "https://github.com/acme/tool/pull/9", "https://github.com/features/actions", "https://github.com/acme", "https://gitlab.com/acme/tool"]) {
      expect(parseGithub(new URL(url))).toBeNull();
    }
  });
});

describe("fetchGithub", () => {
  test("a repository: description, README, then its files", async () => {
    const page = await fetchGithub(link("https://github.com/acme/tool"), opts());
    expect(page.url).toBe("https://github.com/acme/tool");
    expect(page.title).toBe("acme/tool");
    expect(page.text).toStartWith("# acme/tool\n\nA handy tool.\n\nDefault branch: main · JavaScript · ★ 42\n\n## README\n\n# Tool\n\nRun `npm start`.");
    expect(page.text).toContain("## Files (3)\n\nREADME.md\nsrc/server.js\nsrc/tools/chart.js");
    expect(page.text).toEndWith("Read a file with web_fetch github.com/acme/tool/blob/main/<path>.");
    expect(seen.find((r) => r.path === "/repos/acme/tool/readme")!.accept).toBe("application/vnd.github.raw");
  });

  test("a big repository's list is cut, and says how to see a folder", async () => {
    const page = await fetchGithub(link("https://github.com/acme/big"), opts());
    expect(page.text).toContain("(No README.)");
    expect(page.text).toContain("## Files (600)");
    expect(page.text).toContain("f499.txt");
    expect(page.text).not.toContain("f500.txt");
    expect(page.text).toContain("(Showing 500 of 600 files: list a folder with web_fetch github.com/acme/big/tree/main/<folder>.)");
  });

  test("a folder", async () => {
    const page = await fetchGithub(link("https://github.com/acme/tool/tree/main/src"), opts());
    expect(page.title).toBe("acme/tool/src at main");
    expect(page.text).toContain("src/server.js\nsrc/tools/chart.js");
    expect(page.text).not.toContain("README.md");
    await expect(fetchGithub(link("https://github.com/acme/tool/tree/main/docs"), opts())).rejects.toThrow("No folder docs in acme/tool at main.");
  });

  test("a file, numbered like read_file, from raw without a token", async () => {
    const page = await fetchGithub(link("https://github.com/acme/tool/blob/main/src/server.js"), opts());
    expect(page.title).toBe("src/server.js");
    expect(page.text).toBe("    1\tconst a = 1;\n    2\tconst b = 2;");
    expect(seen).toEqual([{ path: "/raw/acme/tool/main/src/server.js", auth: null, accept: expect.any(String) }]);
  });

  test("with a token, files come through the API (private repositories work) and the token goes to the API only", async () => {
    const page = await fetchGithub(link("https://github.com/acme/tool/blob/main/src/server.js"), opts("t0k"));
    expect(page.text).toBe("    1\tconst a = 1;\n    2\tconst b = 2;");
    expect(seen.map((r) => [r.path, r.auth])).toEqual([["/repos/acme/tool/contents/src/server.js", "Bearer t0k"]]);
    await fetchGithub(link("https://github.com/acme/tool"), opts("t0k"));
    expect(seen.every((r) => r.auth === "Bearer t0k")).toBe(true);
  });

  test("not found, with hints", async () => {
    await expect(fetchGithub(link("https://github.com/acme/nope"), opts())).rejects.toThrow("Not found on GitHub: acme/nope. If it's a private repository, set GITHUB_TOKEN.");
    await expect(fetchGithub(link("https://github.com/acme/tool/blob/feature/x/a.js"), opts())).rejects.toThrow("If the branch name has a slash in it");
  });

  test("the rate limit says when it resets and what helps", async () => {
    const limited: GithubLink = { kind: "repo", owner: "acme", repo: "limited" };
    await expect(fetchGithub(limited, opts())).rejects.toThrow("GitHub's API limit (60 requests an hour without a token) is used up until");
    await expect(fetchGithub(limited, opts())).rejects.toThrow("Set GITHUB_TOKEN for 5,000 an hour.");
  });
});
