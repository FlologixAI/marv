import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { dns } from "../src/tools/web/address.ts";
import { fetchPage, get, parseUrl } from "../src/tools/web/fetch.ts";

const ARTICLE = `<html><head><title>Post</title></head><body><nav>Menu</nav><article><p>${"Plenty of article text to read here. ".repeat(10)}</p></article></body></html>`;
const text = (body: string | Uint8Array, type = "text/plain") => new Response(body, { headers: { "content-type": type } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

let server: ReturnType<typeof Bun.serve>;
let base: string; // http://localhost:<port>
let other: string; // the same server under another host name: http://127.0.0.1:<port>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      switch (new URL(req.url).pathname) {
        case "/article": return text(ARTICLE, "text/html; charset=utf-8");
        case "/data.json": return Response.json({ ok: true });
        case "/notes.txt": return text("plain notes\n");
        case "/latin1": return text(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "text/plain; charset=iso-8859-1");
        case "/logo.png": return text(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0]), "image/png");
        case "/binary": return text(new Uint8Array([1, 0, 2, 0]));
        case "/big": return text("x".repeat(5000));
        case "/missing": return new Response("nope", { status: 404, statusText: "Not Found" });
        case "/hop": return redirect(`${base}/hop2`);
        case "/hop2": return redirect("/notes.txt", 301); // relative
        case "/loop": return redirect("/loop");
        case "/to-other": return redirect(`${other}/echo-auth`);
        case "/echo-auth": return text(req.headers.get("authorization") ?? "none");
        case "/slow": await Bun.sleep(1000); return text("late");
      }
      return new Response("unknown", { status: 500 });
    },
  });
  base = `http://localhost:${server.port}`;
  other = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const local = { allowPrivate: true };

describe("parseUrl", () => {
  test("adds https when the scheme is missing", () => {
    expect(parseUrl("github.com/a/b").href).toBe("https://github.com/a/b");
    expect(parseUrl("http://x.example/").href).toBe("http://x.example/");
  });
  test("a useful error for nonsense", () => {
    expect(() => parseUrl("http://")).toThrow("Not a valid URL: http://. Give the full address, e.g. https://example.com/page.");
  });
});

describe("fetchPage", () => {
  test("HTML becomes Markdown with its title", async () => {
    const page = await fetchPage(`${base}/article`, local);
    expect(page.url).toBe(`${base}/article`);
    expect(page.title).toBe("Post");
    expect(page.text).toContain("Plenty of article text");
    expect(page.text).not.toContain("Menu");
  });

  test("JSON and text come as they are, in their charset", async () => {
    expect((await fetchPage(`${base}/data.json`, local)).text).toBe('{"ok":true}');
    expect((await fetchPage(`${base}/notes.txt`, local)).text).toBe("plain notes\n");
    expect((await fetchPage(`${base}/latin1`, local)).text).toBe("café");
  });

  test("refuses what isn't text", async () => {
    await expect(fetchPage(`${base}/logo.png`, local)).rejects.toThrow(`${base}/logo.png is image/png, not text: web_fetch reads pages and text files only.`);
    await expect(fetchPage(`${base}/binary`, local)).rejects.toThrow("looks like a binary file");
  });

  test("a size limit", async () => {
    await expect(fetchPage(`${base}/big`, { ...local, maxBytes: 1000 })).rejects.toThrow(`${base}/big is larger than 1000 bytes, the most web_fetch reads.`);
  });

  test("an HTTP error says what and where", async () => {
    await expect(fetchPage(`${base}/missing`, local)).rejects.toThrow(`404 Not Found at ${base}/missing.`);
  });

  test("follows redirects, relative ones too, and says where it ended up", async () => {
    const page = await fetchPage(`${base}/hop`, local);
    expect(page.url).toBe(`${base}/notes.txt`);
    expect(page.text).toBe("plain notes\n");
  });

  test("gives up on a redirect loop", async () => {
    await expect(fetchPage(`${base}/loop`, local)).rejects.toThrow("Too many redirects (more than 5)");
  });

  test("times out", async () => {
    await expect(fetchPage(`${base}/slow`, { ...local, timeoutMs: 100 })).rejects.toThrow(`Timed out after 0.1 s fetching ${base}/slow.`);
  });

  test("a redirect to a private address is refused (each hop is checked)", async () => {
    const lookup = spyOn(dns, "lookup").mockResolvedValue(["93.184.215.14"]);
    const net = spyOn(globalThis, "fetch").mockImplementation((async () => redirect("http://127.0.0.1:9222/json")) as unknown as typeof fetch);
    try {
      await expect(fetchPage("https://public.example/start")).rejects.toThrow("Refused: 127.0.0.1 is a private address");
      expect(net).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
      net.mockRestore();
    }
  });
});

describe("get", () => {
  test("headers go to the first host only, never along a redirect to another", async () => {
    const headers = { authorization: "Bearer secret" };
    expect((await get(`${base}/echo-auth`, { ...local, headers })).body).toBe("Bearer secret");
    expect((await get(`${base}/to-other`, { ...local, headers })).body).toBe("none");
  });

  test("returns an error status instead of throwing (the caller knows what it means)", async () => {
    const got = await get(`${base}/missing`, local);
    expect(got.status).toBe(404);
    expect(got.body).toBe("nope");
  });
});
