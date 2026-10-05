import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { checkAddress, dns, DNS_TIMEOUT_MS, isPrivateAddress } from "../src/tools/web/address.ts";

describe("isPrivateAddress", () => {
  test.each([
    "127.0.0.1", "127.0.0.2", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.5", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::", "::1", "[::1]", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.0.1", "64:ff9b::a00:1", "not an address",
    // ranges added in review: IETF protocol assignments, benchmarking, local-use NAT64, SIIT, 6to4, site-local
    "192.0.0.1", "198.18.0.1", "198.19.255.255",
    "64:ff9b:1::a00:1", "::ffff:0:8.8.8.8", "2002:7f00:1::", "2002:c0a8:101::", "fec0::1", "feff::1",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(["93.184.215.14", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8",
    "172.15.255.255", "100.63.255.255", "169.253.0.1", "223.255.255.255", "198.17.255.255", "198.20.0.1", "64:ff9b::808:808", "2002:808:808::"])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("checkAddress", () => {
  let lookup: { mockRestore(): void } | undefined;
  afterEach(() => {
    lookup?.mockRestore();
    lookup = undefined;
  });
  const check = (url: string) => checkAddress(new URL(url));

  test("only http and https", async () => {
    await expect(check("file:///etc/passwd")).rejects.toThrow("Only http and https links can be fetched, not file.");
    await expect(check("ftp://example.com/")).rejects.toThrow("not ftp.");
  });

  test("refuses private addresses, however they're written", async () => {
    // new URL normalizes 0x7f.1 and 2130706433 to 127.0.0.1, and ::ffff:127.0.0.1 to ::ffff:7f00:1.
    for (const url of ["http://127.0.0.1:9222/json", "http://0x7f.1/", "http://2130706433/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1./", "http://[::FFFF:127.0.0.1]/"]) {
      await expect(check(url)).rejects.toThrow("a private address");
    }
    await expect(check("http://127.0.0.1:9222/json")).rejects.toThrow("Refused: 127.0.0.1 is a private address (this machine or its network). To reach a local server, use bash with network: true (it asks first).");
  });

  test("refuses localhost without asking DNS", async () => {
    lookup = spyOn(dns, "lookup");
    await expect(check("http://localhost:3000/")).rejects.toThrow("Refused: localhost is 127.0.0.1, a private address");
    await expect(check("http://app.localhost/")).rejects.toThrow("a private address");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("refuses a name that resolves to a private address, even among public ones", async () => {
    lookup = spyOn(dns, "lookup").mockResolvedValue(["93.184.215.14", "192.168.1.5"]);
    await expect(check("https://sneaky.example/")).rejects.toThrow("Refused: sneaky.example is 192.168.1.5, a private address");
  });

  test("lets a public site through", async () => {
    lookup = spyOn(dns, "lookup").mockResolvedValue(["93.184.215.14"]);
    await expect(check("https://example.com/page")).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledWith("example.com");
  });

  test("a name that doesn't resolve", async () => {
    lookup = spyOn(dns, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    await expect(check("https://nope.invalid/")).rejects.toThrow("Couldn't resolve nope.invalid: check the address.");
  });

  test("a private address among the answers refuses, in any order", async () => {
    lookup = spyOn(dns, "lookup").mockResolvedValue(["2606:4700::1", "fe80::1%eth0"]);
    await expect(check("https://sneaky.example/")).rejects.toThrow("a private address");
  });

  test("an empty answer fails closed", async () => {
    lookup = spyOn(dns, "lookup").mockResolvedValue([]);
    await expect(check("https://empty.example/")).rejects.toThrow("Couldn't resolve empty.example: check the address.");
  });

  test("looks up the name fetch will resolve: trailing dot kept, brackets dropped", async () => {
    lookup = spyOn(dns, "lookup").mockResolvedValue(["93.184.215.14"]);
    await check("https://Example.com./");
    expect(lookup).toHaveBeenCalledWith("example.com."); // new URL lowercases the host; the dot stays
  });

  test("the timeout is ten seconds", () => {
    expect(DNS_TIMEOUT_MS).toBe(10_000);
  });

  test("a lookup that never answers is cut off by the timeout", async () => {
    lookup = spyOn(dns, "lookup").mockImplementation(() => new Promise<string[]>(() => {}));
    await expect(checkAddress(new URL("https://slow.example/"), { dnsTimeoutMs: 20 })).rejects.toThrow("Couldn't resolve slow.example: timed out.");
  });

  test("an aborted run stops the lookup and isn't blamed on the site", async () => {
    lookup = spyOn(dns, "lookup").mockImplementation(() => new Promise<string[]>(() => {}));
    const controller = new AbortController();
    controller.abort(new Error("stopped by user"));
    const started = Date.now();
    const result = checkAddress(new URL("https://slow.example/"), { signal: controller.signal });
    await expect(result).rejects.toThrow("stopped by user");
    await expect(result).rejects.not.toThrow("Couldn't resolve");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("allowPrivate (tests only) skips the address check, not the scheme check", async () => {
    await expect(checkAddress(new URL("http://127.0.0.1/"), { allowPrivate: true })).resolves.toBeUndefined();
    await expect(checkAddress(new URL("file:///x"), { allowPrivate: true })).rejects.toThrow("Only http and https");
  });
});
