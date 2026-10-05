import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { checkAddress, dns, isPrivateAddress } from "../src/tools/web/address.ts";

describe("isPrivateAddress", () => {
  test.each([
    "127.0.0.1", "127.0.0.2", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.5", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::", "::1", "[::1]", "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.0.1", "64:ff9b::a00:1", "not an address",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(["93.184.215.14", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8"])("%s is public", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("checkAddress", () => {
  let lookup: { mockRestore(): void } | undefined;
  afterEach(() => lookup?.mockRestore());
  const check = (url: string) => checkAddress(new URL(url));

  test("only http and https", async () => {
    await expect(check("file:///etc/passwd")).rejects.toThrow("Only http and https links can be fetched, not file.");
    await expect(check("ftp://example.com/")).rejects.toThrow("not ftp.");
  });

  test("refuses private addresses, however they're written", async () => {
    // new URL normalizes 0x7f.1 and 2130706433 to 127.0.0.1, and ::ffff:127.0.0.1 to ::ffff:7f00:1.
    for (const url of ["http://127.0.0.1:9222/json", "http://0x7f.1/", "http://2130706433/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/"]) {
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

  test("allowPrivate (tests only) skips the address check, not the scheme check", async () => {
    await expect(checkAddress(new URL("http://127.0.0.1/"), { allowPrivate: true })).resolves.toBeUndefined();
    await expect(checkAddress(new URL("file:///x"), { allowPrivate: true })).rejects.toThrow("Only http and https");
  });
});
