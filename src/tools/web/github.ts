// GitHub links, read through GitHub's API instead of its HTML (which is mostly menus): a repository becomes
// its description, README and file list, so the model can explore it like the project (glob, then read_file);
// a file becomes its raw text. A token goes to the API host only.
import { ToolError } from "../types.ts";
import { get, httpError, type GetOptions, type Got, type Page } from "./fetch.ts";

export type GithubLink =
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "tree"; owner: string; repo: string; ref: string; dir: string }
  | { kind: "blob"; owner: string; repo: string; ref: string; path: string };

export interface GithubOptions extends GetOptions {
  /** GITHUB_TOKEN: 5,000 API requests an hour instead of 60, and private repositories. */
  token?: string;
  apiBase?: string;
  rawBase?: string;
}

interface RepoInfo {
  full_name: string;
  description: string | null;
  default_branch: string;
  stargazers_count?: number;
  language?: string | null;
  homepage?: string | null;
  archived?: boolean;
}
interface Tree {
  tree: { path: string; type: string }[];
  truncated?: boolean;
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const MAX_FILES = 500;
/** github.com/<these>/… are GitHub's own pages, not repositories. */
const NOT_OWNERS = new Set(["about", "apps", "collections", "enterprise", "explore", "features", "login", "marketplace", "new", "notifications", "organizations", "orgs", "pricing", "search", "settings", "signup", "sponsors", "topics", "trending", "users"]);
const SLASH_HINT = " If the branch name has a slash in it, the link is ambiguous: use the commit hash instead.";

/** The repository, folder or file a github.com link points to; null for anything else (issues, PRs…: read as a web page). */
export function parseGithub(url: URL): GithubLink | null {
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, name, kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
  if (!owner || !name || NOT_OWNERS.has(owner)) return null;
  const repo = name.replace(/\.git$/, "");
  if (kind === undefined) return { kind: "repo", owner, repo };
  if (kind === "tree" && ref) return { kind: "tree", owner, repo, ref, dir: rest.join("/") };
  if (kind === "blob" && ref && rest.length) return { kind: "blob", owner, repo, ref, path: rest.join("/") };
  return null;
}

export function fetchGithub(link: GithubLink, options: GithubOptions = {}): Promise<Page> {
  if (link.kind === "repo") return overview(link, options);
  if (link.kind === "tree") return folder(link, options);
  return file(link, options);
}

async function overview({ owner, repo }: { owner: string; repo: string }, options: GithubOptions): Promise<Page> {
  const base = `/repos/${owner}/${repo}`;
  const got = await api(base, options);
  if (got.status === 404) throw notFound(`${owner}/${repo}`, options);
  const info = JSON.parse(got.body) as RepoInfo;
  const branch = info.default_branch;
  const readme = await api(`${base}/readme`, options, "application/vnd.github.raw");
  const tree = await api(`${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`, options);
  const listed: Tree = tree.status === 404 ? { tree: [] } : (JSON.parse(tree.body) as Tree);
  const facts = [`Default branch: ${branch}`, info.language, info.stargazers_count !== undefined && `★ ${info.stargazers_count}`, info.homepage, info.archived && "archived"];
  const text = [
    `# ${info.full_name}`,
    info.description ?? "",
    facts.filter(Boolean).join(" · "),
    readme.status === 404 ? "(No README.)" : `## README\n\n${readme.body.trim()}`,
    listing(filesOf(listed), Boolean(listed.truncated), `${owner}/${repo}`, branch),
  ];
  return { url: `https://github.com/${owner}/${repo}`, title: info.full_name, text: text.filter(Boolean).join("\n\n") };
}

async function folder({ owner, repo, ref, dir }: { owner: string; repo: string; ref: string; dir: string }, options: GithubOptions): Promise<Page> {
  const got = await api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, options);
  if (got.status === 404) throw notFound(`${owner}/${repo} at ${ref}`, options, SLASH_HINT);
  const tree = JSON.parse(got.body) as Tree;
  const files = filesOf(tree, dir);
  if (dir && files.length === 0) throw new ToolError(`No folder ${dir} in ${owner}/${repo} at ${ref}.${SLASH_HINT}`);
  const where = dir ? `${owner}/${repo}/${dir}` : `${owner}/${repo}`;
  return {
    url: `https://github.com/${owner}/${repo}/tree/${ref}${dir ? `/${dir}` : ""}`,
    title: `${where} at ${ref}`,
    text: listing(files, Boolean(tree.truncated), `${owner}/${repo}`, ref),
  };
}

async function file({ owner, repo, ref, path }: { owner: string; repo: string; ref: string; path: string }, options: GithubOptions): Promise<Page> {
  // With a token, through the API (private repositories work); without one, from raw.githubusercontent.com,
  // which doesn't count toward the 60-an-hour limit. The raw request gets no headers: no token there.
  const got = options.token
    ? await api(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, options, "application/vnd.github.raw")
    : await get(`${options.rawBase ?? RAW}/${owner}/${repo}/${ref}/${path}`, { ...options, headers: undefined });
  if (got.status === 404) throw notFound(`${path} at ${ref} in ${owner}/${repo}`, options, SLASH_HINT);
  if (got.status < 200 || got.status >= 300) throw httpError(got);
  const lines = got.body.replace(/\n$/, "").split("\n");
  return {
    url: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`,
    title: path,
    text: lines.map((line, i) => `${String(i + 1).padStart(5)}\t${line}`).join("\n"),
  };
}

/** A GitHub API request. A 404 is returned (the caller says what wasn't found); other errors are thrown. */
async function api(path: string, options: GithubOptions, accept = "application/vnd.github+json"): Promise<Got> {
  const headers: Record<string, string> = { accept, "x-github-api-version": "2022-11-28" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const got = await get(`${options.apiBase ?? API}${path}`, { ...options, headers });
  if ((got.status === 403 || got.status === 429) && got.headers.get("x-ratelimit-remaining") === "0") throw rateLimited(got, options);
  if (got.status !== 404 && (got.status < 200 || got.status >= 300)) throw httpError(got);
  return got;
}

function rateLimited(got: Got, { token }: GithubOptions): ToolError {
  const reset = Number(got.headers.get("x-ratelimit-reset"));
  const until = reset ? ` until ${new Date(reset * 1000).toLocaleTimeString()}` : "";
  return new ToolError(
    token
      ? `GitHub's API limit for your token is used up${until}.`
      : `GitHub's API limit (60 requests an hour without a token) is used up${until}. Set GITHUB_TOKEN for 5,000 an hour.`,
  );
}

const notFound = (what: string, { token }: GithubOptions, hint = "") =>
  new ToolError(`Not found on GitHub: ${what}.${hint}${token ? "" : " If it's a private repository, set GITHUB_TOKEN."}`);

const filesOf = (tree: Tree, dir = "") => tree.tree.filter((e) => e.type === "blob" && (!dir || e.path.startsWith(`${dir}/`))).map((e) => e.path);

function listing(paths: string[], truncated: boolean, repo: string, ref: string): string {
  const shown = paths.slice(0, MAX_FILES);
  const cut =
    paths.length > MAX_FILES || truncated
      ? `\n(Showing ${shown.length} of ${truncated ? "more than " : ""}${paths.length} files: list a folder with web_fetch github.com/${repo}/tree/${ref}/<folder>.)`
      : "";
  return `## Files (${paths.length}${truncated ? "+" : ""})\n\n${shown.join("\n")}${cut}\n\nRead a file with web_fetch github.com/${repo}/blob/${ref}/<path>.`;
}
