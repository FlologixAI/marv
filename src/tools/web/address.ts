// Where web_fetch may connect: the public internet only. The model picks the URL, and a page it reads can
// carry planted instructions; without this they could make it fetch something on the user's own machine or
// network: a router's admin page, TradingView's debugging port (localhost:9222), a cloud machine's metadata
// service (169.254.169.254) and the credentials it hands out.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ToolError } from "../types.ts";

/** Name resolution, an object so tests (which have no network) can replace it. */
export const dns = {
  lookup: async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map((a) => a.address),
};

function privateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The eight 16-bit groups of an IPv6 address ("::1" → 0,0,0,0,0,0,0,1); a dotted IPv4 tail counts as two. */
function groupsV6(ip: string): number[] {
  let text = ip.split("%")[0]!; // a zone ("fe80::1%eth0") isn't part of the address
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const groups = (part: string) => (part ? part.split(":").map((g) => parseInt(g, 16)) : []);
  const [head = "", rest] = text.split("::");
  if (rest === undefined) return groups(head);
  const left = groups(head);
  const right = groups(rest);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function privateV6(ip: string): boolean {
  const g = groupsV6(ip);
  const first = g[0] ?? 0;
  const v4 = () => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, and the old IPv4-compatible form
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(v4()); // ::ffff:127.0.0.1
  if (first === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(v4()); // NAT64
  // unique local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** Whether an address is on the user's own machine or network. Not an address at all: refused rather than guessed. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "");
  const kind = isIP(ip.split("%")[0]!);
  if (kind === 4) return privateV4(ip);
  if (kind === 6) return privateV6(ip);
  return true;
}

/**
 * Refuses a URL web_fetch mustn't fetch: anything but http(s), or a host that is, or resolves to, a private
 * address. `new URL` has already normalized odd spellings of an address (0x7f.1, 2130706433 → 127.0.0.1).
 */
export async function checkAddress(url: URL, { allowPrivate = false }: { allowPrivate?: boolean } = {}): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError(`Only http and https links can be fetched, not ${url.protocol.replace(/:$/, "")}.`);
  }
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else if (host === "localhost" || host.endsWith(".localhost")) addresses = ["127.0.0.1"];
  else {
    try {
      addresses = await dns.lookup(host);
    } catch {
      throw new ToolError(`Couldn't resolve ${host}: check the address.`);
    }
  }
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) {
    const subject = blocked === host ? `${host} is` : `${host} is ${blocked},`;
    throw new ToolError(`Refused: ${subject} a private address (this machine or its network). To reach a local server, use bash with network: true (it asks first).`);
  }
}
