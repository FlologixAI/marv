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
/** Bigger pages (plain text and GitHub files can reach 5 MB) aren't kept: eight of them would be a lot of memory. */
const CACHE_MAX_CHARS = 1_000_000;
/** GitHub's other hosts count as github.com: one "don't ask again" covers them all. */
const GITHUB_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com", "gist.github.com", "gist.githubusercontent.com"]);

/** The site an approval covers: the host, lowercased, without www. Ports and http/https share a domain's scope,
 * like Claude Code's per-domain rule. */
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
  // Code isn't a link the user means to visit (a pasted script or log may name any host): drop fenced blocks
  // (closed or not, ``` and ~~~) and inline code spans before looking.
  // Fences follow CommonMark: a block opens on a line starting with 3+ backticks or tildes and closes on a line of
  // at least as many of the same character with nothing after (an unclosed one runs to the end). An unclosed run
  // mid-line is literal text, so only a closed inline run hides anything.
  const prose = text.replace(/^[ \t]*(([`~])\2{2,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1\2*[ \t]*$|(?![\s\S]))/gm, "").replace(/(```|~~~)[\s\S]*?\1/g, "").replace(/`[^`\n]*`/g, "");
  const links = (prose.match(/https?:\/\/[^\s<>"'`\[\]]+/gi) ?? []).map((link) => link.replace(/[.,;:!?)\]]+$/, ""));
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

/** The network settings of the tool; all but `allowPrivate`/`allowHttp`/`apiBase`/`rawBase` (tests only) are the GitHub ones. */
export type WebOptions = Pick<GithubOptions, "allowPrivate" | "allowHttp" | "apiBase" | "rawBase"> & {
  /** Default: GITHUB_TOKEN, else GH_TOKEN, from the environment. Sent to GitHub only. */
  token?: string;
};

interface Cached {
  page: Page;
  at: number;
  keys: string[];
}

/** The tool with its network settings (tests point it at a local server). */
export function makeWebFetch(web: WebOptions = {}): Tool<typeof input> {
  // A page is kept under the URL asked for and the one it ended at (the header shows that one, after same-site
  // redirects, and the model passes it back); both keys share one entry, which counts once toward the limit.
  const recent = new Map<string, Cached>();
  const cachedPage = (url: string) => {
    const hit = recent.get(parseUrl(url).href);
    return hit && Date.now() - hit.at < CACHE_MS ? hit.page : undefined;
  };
  // What needsApproval found, for run: an entry expiring between the two mustn't turn a read we didn't ask about
  // into a download. runTool passes both the same parsed input object.
  const approvedReads = new WeakMap<object, Page>();
  const remember = (keys: string[], page: Page) => {
    for (const key of keys) {
      const old = recent.get(key);
      if (old) for (const k of old.keys) recent.delete(k);
    }
    const entry: Cached = { page, at: Date.now(), keys: [...new Set(keys)] };
    for (const key of entry.keys) recent.set(key, entry); // a Map keeps insertion order: the oldest is first
    while (new Set(recent.values()).size > CACHE_PAGES) {
      const oldest = recent.values().next().value!;
      for (const k of oldest.keys) recent.delete(k);
    }
  };
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
    // A read from the cache sends nothing out, so it doesn't ask again.
    needsApproval: (input) => {
      try {
        const page = input.offset ? cachedPage(input.url) : undefined;
        if (page) approvedReads.set(input, page);
        return !page;
      } catch {
        return true;
      }
    },
    usesNetwork: () => true,
    scope: ({ url }) => ({ key: webScope(url), description: `fetching from ${domainOf(url)}` }),
    async preview({ url }, { signal }) {
      const parsed = parseUrl(url);
      await checkAddress(parsed, { ...web, signal }); // a private address fails here, so nobody is asked to approve it
      return { title: "Fetch a web page", text: parsed.href, note: "GET · fetched by Marv, not in the sandbox" };
    },
    async run(input, { signal }) {
      const { url, offset = 0 } = input;
      const parsed = parseUrl(url);
      // Reading on (offset > 0) reuses the page fetched a moment ago instead of downloading and converting it
      // again; offset 0 always fetches fresh.
      const cached = approvedReads.get(input) ?? (offset > 0 ? cachedPage(url) : undefined);
      if (cached) return paged(cached, offset);
      // A redirect to another site isn't followed: the URL (and its query) could carry data to a site the user
      // never approved. The model gets the target and calls again, which asks if that site is new.
      const followRedirect = (_from: URL, to: URL) => domainOf(to.href) === domainOf(parsed.href);
      const options = { ...web, signal, followRedirect };
      const link = parseGithub(parsed);
      let page: Page;
      if (link) {
        page = await fetchGithub(link, { ...options, token: web.token ?? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined) });
      } else {
        try {
          page = await fetchPage(parsed.href, options);
        } catch (error) {
          // "example.com" got https from parseUrl; a site that only serves http fails to connect, and the model can't tell why.
          const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim());
          if (!typedScheme && error instanceof ToolError && error.message.startsWith("Couldn't fetch ")) {
            throw new ToolError(`${error.message} If the site only serves http, pass an http:// URL.`);
          }
          throw error;
        }
      }
      if (page.text.length > CACHE_MAX_CHARS) return paged(page, offset);
      remember([parsed.href, new URL(page.url).href], page);
      return paged(page, offset);
    },
  };
}

export const webFetch = makeWebFetch();
