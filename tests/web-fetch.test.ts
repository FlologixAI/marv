import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { dns } from "../src/tools/web/address.ts";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fetchPage, get, parseUrl, sendsHeaders } from "../src/tools/web/fetch.ts";

const ARTICLE = `<html><head><title>Post</title></head><body><nav>Menu</nav><article><p>${"Plenty of article text to read here. ".repeat(10)}</p></article></body></html>`;
const text = (body: string | Uint8Array, type = "text/plain") => new Response(body, { headers: { "content-type": type } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

let cancelled = 0; // how many times the endless stream was cut by the client
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
        case "/gzip": return new Response(gzipSync("zipped text"), { headers: { "content-type": "text/plain", "content-encoding": "gzip" } });
        case "/gzip-bomb": return new Response(gzipSync("a".repeat(100_000)), { headers: { "content-type": "text/plain", "content-encoding": "gzip" } });
        case "/br-bomb": return new Response(brotliCompressSync("a".repeat(100_000)), { headers: { "content-type": "text/plain", "content-encoding": "br" } });
        case "/gzip-bad": return new Response("not gzip at all", { headers: { "content-type": "text/plain", "content-encoding": "gzip" } });
        case "/weird-encoding": return new Response("x", { headers: { "content-type": "text/plain", "content-encoding": "zstd" } });
        case "/forever": return new Response(new ReadableStream({ pull: async (c) => { await Bun.sleep(5); c.enqueue(new Uint8Array(2000).fill(97)); }, cancel: () => { cancelled++; } }), { headers: { "content-type": "text/plain" } });
        case "/forever-body": return new Response(new ReadableStream({ pull: async (c) => { await Bun.sleep(20); c.enqueue(new Uint8Array(100).fill(97)); } }), { headers: { "content-type": "text/plain" } });
        case "/big-404": return new Response("e".repeat(200_000), { status: 404, statusText: "Not Found", headers: { "content-type": "text/plain" } });
        case "/cp1252": return new Response(new Uint8Array([...Buffer.from('<html><head><meta charset="windows-1252"><title>Caf'), 0xe9, ...Buffer.from(`</title></head><body><article><p>${"Plenty of article text to read here. ".repeat(10)}caf`), 0xe9, ...Buffer.from("</p></article></body></html>")]), { headers: { "content-type": "text/html" } });
        case "/upper": return text("shout", "TEXT/PLAIN; Charset=UTF-8");
        case "/to-file": return redirect("file:///etc/passwd");
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
  test("a host with a port is not a scheme; the input is trimmed", () => {
    expect(parseUrl("example.com:8080/x").href).toBe("https://example.com:8080/x");
    expect(parseUrl("localhost:3000").href).toBe("https://localhost:3000/");
    expect(parseUrl("  https://x.example/a \n").href).toBe("https://x.example/a");
    expect(parseUrl("mailto:a@b.example").protocol).toBe("mailto:");
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
  // The local server is http, and credentials never travel over http, so the rule is tested as a unit
  // (same origin and https) and the integration tests show that nothing is sent here.
  test("headers go only to the first origin, and only over https", () => {
    const u = (x: string) => new URL(x);
    expect(sendsHeaders(u("https://a.example/x"), u("https://a.example/y"))).toBe(true);
    expect(sendsHeaders(u("https://a.example/x"), u("https://b.example/y"))).toBe(false);
    expect(sendsHeaders(u("https://a.example/x"), u("https://a.example:8443/y"))).toBe(false);
    expect(sendsHeaders(u("https://a.example/x"), u("http://a.example/y"))).toBe(false); // downgrade, same host
    expect(sendsHeaders(u("http://a.example/x"), u("http://a.example/y"))).toBe(false); // never in clear
  });

  test("headers are not sent over http, nor along a redirect to another host", async () => {
    const headers = { authorization: "Bearer secret" };
    expect((await get(`${base}/echo-auth`, { ...local, headers })).body).toBe("none");
    expect((await get(`${base}/to-other`, { ...local, headers })).body).toBe("none");
  });

  test("compressed bodies are decoded", async () => {
    expect((await get(`${base}/gzip`, local)).body).toBe("zipped text");
  });

  test("a compression bomb is refused, small on the wire", async () => {
    await expect(get(`${base}/gzip-bomb`, { ...local, maxBytes: 1000 })).rejects.toThrow("is larger than 1000 bytes, the most web_fetch reads.");
    await expect(get(`${base}/br-bomb`, { ...local, maxBytes: 1000 })).rejects.toThrow("is larger than 1000 bytes, the most web_fetch reads.");
  });

  test("a damaged or unknown encoding is an error", async () => {
    await expect(get(`${base}/gzip-bad`, local)).rejects.toThrow("the response is damaged.");
    await expect(get(`${base}/weird-encoding`, local)).rejects.toThrow("encoding web_fetch can't read (zstd)");
  });

  test("leaving a too-large body closes the connection", async () => {
    const before = cancelled;
    await expect(get(`${base}/forever`, { ...local, maxBytes: 10_000 })).rejects.toThrow("larger than");
    const until = Date.now() + 1000;
    while (cancelled === before && Date.now() < until) await Bun.sleep(20);
    expect(cancelled).toBeGreaterThan(before);
  });

  test("a user abort mid-body rejects with the user's reason, not a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stopped by user")), 150);
    await expect(get(`${base}/forever-body`, { ...local, signal: controller.signal, maxBytes: 10_000_000 })).rejects.toThrow("stopped by user");
  });

  test("a redirect to a file: URL is refused", async () => {
    await expect(get(`${base}/to-file`, local)).rejects.toThrow();
  });

  test("an error page is cut at 64 KB instead of failing", async () => {
    const got = await get(`${base}/big-404`, local);
    expect(got.status).toBe(404);
    expect(got.body.length).toBe(64 * 1024);
  });

  test("content-type is case-insensitive", async () => {
    expect((await fetchPage(`${base}/upper`, local)).text).toBe("shout");
  });

  test("HTML without a charset header uses its meta tag", async () => {
    const page = await fetchPage(`${base}/cp1252`, local);
    expect(page.title).toBe("Café");
    expect(page.text).toContain("café");
  });

  test("returns an error status instead of throwing (the caller knows what it means)", async () => {
    const got = await get(`${base}/missing`, local);
    expect(got.status).toBe(404);
    expect(got.body).toBe("nope");
  });
});
