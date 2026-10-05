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
});
