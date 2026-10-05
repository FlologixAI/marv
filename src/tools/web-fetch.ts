// web_fetch: read a web page, or a GitHub repository, from a link. Marv fetches it itself (the sandbox has no
// network), so it can refuse addresses on the user's own network, limit what it downloads, and ask per site.
import { z } from "zod";
import { ToolError, type Tool, type ToolResult } from "./types.ts";
import { checkAddress } from "./web/address.ts";
import { fetchPage, parseUrl, type Page } from "./web/fetch.ts";
import { fetchGithub, parseGithub, type GithubOptions } from "./web/github.ts";

export const PAGE_CHARS = 30_000;
/** Pages kept for reading on with offset: a few, briefly (a page changes, and they can be 300k characters each). */
const CACHE_PAGES = 8;
const CACHE_MS = 10 * 60_000;
/** GitHub's other hosts count as github.com: one "don't ask again" covers them all. */
const GITHUB_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com", "gist.github.com", "gist.githubusercontent.com"]);

/** The site an approval covers: the host, lowercased, without www. */
export function domainOf(url: string): string {
  let host: string;
  try {
    host = parseUrl(url).hostname;
  } catch {
    return url;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  return GITHUB_HOSTS.has(host) ? "github.com" : host;
}

export const webScope = (url: string) => `web:${domainOf(url)}`;

/** The scopes of the links in what the user typed: sites they pasted are theirs to fetch, without asking. */
export function pastedScopes(text: string): string[] {
  const links = (text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? []).map((link) => link.replace(/[.,;:!?)\]]+$/, ""));
  return [...new Set(links.map(webScope))];
}

const chars = (n: number) => (n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(1)}k chars`);

/** The part of a page the model reads now, under a header saying what it is and how to read on. */
export function paged(page: Page, offset: number, size = PAGE_CHARS): ToolResult {
  const total = page.text.length;
  if (offset > 0 && offset >= total) throw new ToolError(`offset ${offset} is past the end (${total} characters).`);
  const end = Math.min(total, offset + size);
  const partial = offset > 0 || end < total;
  const range = partial ? ` · characters ${offset}-${end} of ${total}${end < total ? ` (offset: ${end} for the next part)` : ""}` : "";
  const header = [`Fetched ${page.url}`, page.title].filter(Boolean).join(" · ") + range;
  const note = page.note ? `\n(${page.note})` : "";
  return {
    output: `${header}${note}\n\n${page.text.slice(offset, end) || "(empty page)"}`,
    summary: partial ? `${chars(end - offset).replace(" chars", "")} of ${chars(total)}` : chars(total),
  };
}

const input = z.object({
  url: z.string().describe("The address, e.g. https://example.com/page or github.com/owner/repo."),
  offset: z.number().int().min(0).optional().describe("Where to start, in characters, for the next part of a long result (the result says what to pass). Default 0."),
});

export interface WebOptions {
  /** Tests only: let a local server through. */
  allowPrivate?: boolean;
  apiBase?: string;
  rawBase?: string;
  /** Default: GITHUB_TOKEN, else GH_TOKEN, from the environment. */
  token?: string;
}

/** The tool with its network settings (tests point it at a local server). */
export function makeWebFetch(web: WebOptions = {}): Tool<typeof input> {
  const recent = new Map<string, { page: Page; at: number }>();
  return {
    name: "web_fetch",
    description:
      "Fetch a web page and read it as Markdown (plain text and JSON as they are). A GitHub repository link (github.com/owner/repo) gives its description, README and file list; " +
      "read one of its files with github.com/owner/repo/blob/<branch>/<path>, list a folder with github.com/owner/repo/tree/<branch>/<folder>. " +
      `Long results come in parts of ${PAGE_CHARS.toLocaleString("en")} characters: pass the offset the result names to read the next. ` +
      "Public sites only, not localhost or the local network. The user may be asked to approve each new site.",
    input,
    kind: "read",
    label: ({ url }) => url.replace(/^https?:\/\//, ""),
    // Asks once per site (the scope), and sites the user pasted are already allowed (the App adds their
    // scopes). No autoSafe, so yolo never skips it: the URL itself can carry data out (?k=<a secret>).
    needsApproval: () => true,
    usesNetwork: () => true,
    scope: ({ url }) => ({ key: webScope(url), description: `fetching from ${domainOf(url)}` }),
    async preview({ url }, { signal }) {
      const parsed = parseUrl(url);
      await checkAddress(parsed, { ...web, signal }); // a private address fails here, so nobody is asked to approve it
      return { title: "Fetch a web page", text: parsed.href, note: "GET · fetched by Marv, not in the sandbox" };
    },
    async run({ url, offset = 0 }, { signal }) {
      const parsed = parseUrl(url);
      // Reading on (offset > 0) reuses the page fetched a moment ago instead of downloading and converting it
      // again; offset 0 always fetches fresh.
      const cached = offset > 0 ? recent.get(parsed.href) : undefined;
      if (cached && Date.now() - cached.at < CACHE_MS) return paged(cached.page, offset);
      const options: GithubOptions = { ...web, signal, token: web.token ?? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined) };
      const link = parseGithub(parsed);
      const page = link ? await fetchGithub(link, options) : await fetchPage(parsed.href, options);
      recent.delete(parsed.href); // re-inserted last: a Map keeps insertion order, so the oldest is first
      recent.set(parsed.href, { page, at: Date.now() });
      if (recent.size > CACHE_PAGES) recent.delete(recent.keys().next().value!);
      return paged(page, offset);
    },
  };
}

export const webFetch = makeWebFetch();
