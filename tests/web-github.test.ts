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
let seen: { path: string; search: string; auth: string | null; accept: string | null; version: string | null }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, search: url.search, auth: req.headers.get("authorization"), accept: req.headers.get("accept"), version: req.headers.get("x-github-api-version") });
      switch (url.pathname) {
        case "/repos/acme/tool": return Response.json({ full_name: "acme/tool", description: "A handy tool.", default_branch: "main", stargazers_count: 42, language: "JavaScript" });
        case "/repos/acme/tool/readme": return raw("# Tool\n\nRun `npm start`.\n");
        case "/repos/acme/tool/git/trees/main": return Response.json(TREE);
        case "/repos/acme/tool/contents/src/server.js": return raw("const a = 1;\nconst b = 2;\n");
        case "/raw/acme/tool/main/src/server.js": return new Response("const a = 1;\nconst b = 2;\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
        case "/repos/acme/big": return Response.json({ full_name: "acme/big", description: null, default_branch: "main" });
        case "/repos/acme/big/git/trees/main": return Response.json({ tree: Array.from({ length: 600 }, (_, i) => ({ path: `f${i}.txt`, type: "blob" })), truncated: false });
        case "/repos/acme/tool/contents": return Response.json([{ name: "README.md", path: "README.md", type: "file" }, { name: "src", path: "src", type: "dir" }]);
        case "/repos/acme/tool/contents/src": return Response.json([
          { name: "server.js", path: "src/server.js", type: "file" },
          { name: "tools", path: "src/tools", type: "dir" },
          { name: "vendor", path: "src/vendor", type: "submodule" },
          { name: "link", path: "src/link", type: "symlink" },
        ]);
        case "/repos/acme/tool/contents/README.md": return Response.json({ name: "README.md", path: "README.md", type: "file" });
        case "/repos/acme/tool/contents/my%20dir": return Response.json([{ name: "a b.txt", path: "my dir/a b.txt", type: "file" }]);
        case "/repos/acme/tool/contents/my%20dir/a%20b.txt": return raw("spaced\n");
        case "/raw/acme/tool/main/my%20dir/a%20b.txt": return new Response("spaced\n", { headers: { "content-type": "text/plain" } });
        case "/repos/acme/big/contents": return Response.json([{ name: "f0.txt", path: "f0.txt", type: "file" }, { name: "lib", path: "lib", type: "dir" }]);
        case "/repos/acme/trunc": return Response.json({ full_name: "acme/trunc", description: null, default_branch: "main" });
        case "/repos/acme/trunc/git/trees/main": return Response.json({ tree: [{ path: "a.txt", type: "blob" }], truncated: true });
        case "/repos/acme/trunc/contents": return Response.json([{ name: "a.txt", path: "a.txt", type: "file" }, { name: "src", path: "src", type: "dir" }]);
        case "/repos/acme/empty": return Response.json({ full_name: "acme/empty", description: null, default_branch: "main" });
        case "/repos/acme/empty/git/trees/main": return Response.json({ message: "Git Repository is empty." }, { status: 409 });
        case "/repos/acme/subm": return Response.json({ full_name: "acme/subm", description: null, default_branch: "main" });
        case "/repos/acme/subm/git/trees/main": return Response.json({ tree: [{ path: "a.txt", type: "blob" }, { path: "vendor/lib", type: "commit" }], truncated: false });
        case "/repos/acme/longreadme": return Response.json({ full_name: "acme/longreadme", description: null, default_branch: "main" });
        case "/repos/acme/longreadme/readme": return raw("x".repeat(13_000));
        case "/repos/acme/longreadme/git/trees/main": return Response.json({ tree: [{ path: "docs/readme.txt", type: "blob" }, { path: "readme.markdown", type: "blob" }], truncated: false });
        case "/repos/acme/moved": return new Response(null, { status: 301, headers: { location: "/repositories/123" } });
        case "/repositories/123": return Response.json({ full_name: "acme/moved2", description: null, default_branch: "main" });
        case "/repos/acme/forbidden": return Response.json({ message: "Repository access blocked" }, { status: 403, statusText: "Forbidden" });
        case "/repos/acme/secondary": return new Response("{}", { status: 403, headers: { "retry-after": "30" } });
        case "/repos/acme/proxy": return new Response("<html>Please log in</html>", { headers: { "content-type": "text/html" } });
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

  test("percent-escapes are decoded once", () => {
    expect(parseGithub(new URL("https://github.com/acme/tool/tree/f%C3%BCr/my%20dir"))).toEqual({ kind: "tree", owner: "acme", repo: "tool", ref: "für", dir: "my dir" });
    expect(parseGithub(new URL("https://github.com/acme/tool/tree/feature%2Fx"))).toEqual({ kind: "tree", owner: "acme", repo: "tool", ref: "feature/x", dir: "" });
    expect(parseGithub(new URL("https://github.com/acme/tool/blob/main/a%20b.txt"))).toMatchObject({ kind: "blob", path: "a b.txt" });
    expect(parseGithub(new URL("https://github.com/acme/my.repo-1"))).toEqual({ kind: "repo", owner: "acme", repo: "my.repo-1" });
    expect(parseGithub(new URL("https://github.com/acme/tool/tree/%E0%A4%A"))).toBeNull(); // not valid UTF-8 / escape
  });

  test("names that could reach another endpoint are refused", () => {
    for (const url of [
      "https://github.com/x%2F..%2F..%2Fuser%2Femails%3F/r", // owner
      "https://github.com/acme%20x/tool",
      "https://github.com/acme/to%6Fl%3Fx", // repo with ?
      "https://github.com/acme/tool/blob/main/a%2Fb",
      "https://github.com/acme/tool/blob/main/a%3Fb",
      "https://github.com/acme/tool/tree/main/x%23y",
      "https://github.com/acme/tool/blob/main/a%00b",
      "https://github.com/acme/tool/tree/x..y",
      "https://github.com/acme/tool/tree/a%3Fb",
      "https://github.com/acme/tool/tree/a%23b",
      "https://github.com/acme/tool/tree/a%0Ab",
      "https://github.com/acme/tool/tree/%2Fx",
    ]) {
      expect(parseGithub(new URL(url))).toBeNull();
    }
  });

  test("anything else is read as a web page", () => {
    for (const url of ["https://github.com/acme/tool/issues/3", "https://github.com/acme/tool/pull/9", "https://github.com/features/actions", "https://github.com/issues/assigned", "https://github.com/acme", "https://gitlab.com/acme/tool"]) {
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
    expect(seen.find((r) => r.path === "/repos/acme/tool/git/trees/main")!.search).toContain("recursive=1");
    expect(seen.every((r) => r.version === "2022-11-28")).toBe(true);
  });

  test("an empty repository says so", async () => {
    const page = await fetchGithub(link("https://github.com/acme/empty"), opts());
    expect(page.text).toContain("(Empty repository.)");
    expect(page.text).not.toContain("## Files");
  });

  test("submodules are marked", async () => {
    const page = await fetchGithub(link("https://github.com/acme/subm"), opts());
    expect(page.text).toContain("a.txt\nvendor/lib (submodule)");
  });

  test("a truncated tree falls back to the top level", async () => {
    const page = await fetchGithub(link("https://github.com/acme/trunc"), opts());
    expect(page.text).toContain("The repository is too big to list whole: these are its top-level entries; list a folder with web_fetch github.com/acme/trunc/tree/main/<folder>.");
    expect(page.text).toContain("a.txt\nsrc/");
    expect(seen.find((r) => r.path === "/repos/acme/trunc/contents")!.search).toBe("?ref=main");
  });

  test("a tree too big to download falls back the same way", async () => {
    const page = await fetchGithub(link("https://github.com/acme/big"), { ...opts(), maxBytes: 1000 });
    expect(page.text).toContain("top-level entries");
    expect(page.text).toContain("f0.txt\nlib/");
  });

  test("a long README is cut and says where to read the rest", async () => {
    const page = await fetchGithub(link("https://github.com/acme/longreadme"), opts());
    expect(page.text).toContain("x".repeat(12_000));
    expect(page.text).not.toContain("x".repeat(12_001));
    expect(page.text).toContain("(README cut: read all of it with web_fetch github.com/acme/longreadme/blob/main/readme.markdown)");
  });

  test("an API redirect on the same host keeps the token", async () => {
    const page = await fetchGithub(link("https://github.com/acme/moved"), opts("t0k"));
    expect(page.title).toBe("acme/moved2");
    expect(seen.filter((r) => r.path === "/repos/acme/moved" || r.path === "/repositories/123").map((r) => r.auth)).toEqual(["Bearer t0k", "Bearer t0k"]);
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
    expect(page.text).toContain("src/server.js\nsrc/tools/\nsrc/vendor (submodule)\nsrc/link (symlink)");
    expect(page.text).not.toContain("README.md");
    expect(page.text).toContain("Read a file with web_fetch github.com/acme/tool/blob/main/<path>.");
    expect(seen[0]).toMatchObject({ path: "/repos/acme/tool/contents/src", search: "?ref=main" });
    await expect(fetchGithub(link("https://github.com/acme/tool/tree/main/docs"), opts())).rejects.toThrow("Not found on GitHub: docs at main in acme/tool.");
    await expect(fetchGithub(link("https://github.com/acme/tool/tree/main/README.md"), opts())).rejects.toThrow("README.md is a file: read it with web_fetch github.com/acme/tool/blob/main/README.md.");
  });

  test("the root folder, and escaped names are encoded once", async () => {
    expect((await fetchGithub(link("https://github.com/acme/tool/tree/main"), opts())).text).toContain("README.md\nsrc/");
    expect(seen[0]).toMatchObject({ path: "/repos/acme/tool/contents", search: "?ref=main" });
    seen = [];
    const page = await fetchGithub(link("https://github.com/acme/tool/tree/main/my%20dir"), opts());
    expect(page.title).toBe("acme/tool/my dir at main");
    expect(page.text).toContain("my dir/a b.txt");
    seen = [];
    await fetchGithub(link("https://github.com/acme/tool/tree/feature%2Fx/src"), opts()).catch(() => {});
    await fetchGithub(link("https://github.com/acme/tool/tree/f%C3%BCr/src"), opts()).catch(() => {});
    expect(seen.map((r) => r.search)).toEqual(["?ref=feature%2Fx", "?ref=f%C3%BCr"]);
    const file = await fetchGithub(link("https://github.com/acme/tool/blob/main/my%20dir/a%20b.txt"), opts());
    expect(file.title).toBe("my dir/a b.txt");
    expect(file.text).toBe("    1\tspaced");
  });

  test("a file link to a folder lists it, with a token", async () => {
    const page = await fetchGithub(link("https://github.com/acme/tool/blob/main/src"), opts("t0k"));
    expect(page.title).toBe("acme/tool/src at main");
    expect(page.text).toContain("src/server.js");
  });

  test("a file, numbered like read_file, from raw without a token", async () => {
    const page = await fetchGithub(link("https://github.com/acme/tool/blob/main/src/server.js"), opts());
    expect(page.title).toBe("src/server.js");
    expect(page.text).toBe("    1\tconst a = 1;\n    2\tconst b = 2;");
    expect(seen.map((r) => [r.path, r.auth])).toEqual([["/raw/acme/tool/main/src/server.js", null]]);
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
    await expect(fetchGithub(limited, opts("t0k"))).rejects.toThrow("GitHub's API limit for your token is used up until");
  });

  test("other refusals carry GitHub's message; a secondary limit says to wait", async () => {
    const at = (name: string) => fetchGithub({ kind: "repo", owner: "acme", repo: name }, opts());
    await expect(at("forbidden")).rejects.toThrow("403 Forbidden at");
    await expect(at("forbidden")).rejects.toThrow("Repository access blocked");
    await expect(at("secondary")).rejects.toThrow("GitHub asks to wait 30 s (secondary rate limit).");
  });

  test("an answer that isn't JSON is explained, not a SyntaxError", async () => {
    await expect(fetchGithub({ kind: "repo", owner: "acme", repo: "proxy" }, opts())).rejects.toThrow("GitHub's API answered with something that isn't JSON (a proxy or captive portal?).");
  });
});
