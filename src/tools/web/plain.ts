// The plain-text fallback for a page too complex to convert in time, and the limits both conversions share. This runs
// on the main thread (after the worker was stopped), on HTML that just proved hostile or pathological, so it's one
// linear scan: indexOf and sticky regexes that only move forward, never a pattern that could backtrack over the whole
// page (a `<script[\s\S]*?<\/script>` replace is quadratic on a page of unclosed <script> tags).
import type { Markdown } from "./html.ts";

/** About ten of web_fetch's 30k-character pages: more is rarely read, and turndown slows down faster than its output grows. */
export const MAX_CHARS = 300_000;
const MAX_TITLE = 200;

/** Hidden by an inline style. Stylesheets aren't evaluated, so a class that hides text still gets through. */
export const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0*)?|font-size\s*:\s*0(?:\.0*)?[a-z%]*)\s*(?:!important\s*)?(?:;|$)/i;

/** One line (a newline in the title could forge a line of web_fetch's `Fetched <url> · <title>` header), at most 200 characters. */
export function oneLine(text: string | null | undefined): string | undefined {
  const line = (text ?? "").slice(0, MAX_TITLE * 10).replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (!line) return undefined;
  const chars = Array.from(line); // by code point, so an emoji isn't cut in half
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join("").trimEnd()}…` : line;
}

/** Their content is never text a reader sees. The first group is raw text in HTML (an unclosed <script> swallows the
 *  rest of the page in a browser too); the others are skipped to their end tag if they have one, and are only a tag
 *  otherwise. Neither group nests (a <select> in a <select> isn't a thing), so the first end tag ends them. */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "noscript", "iframe", "noembed", "noframes", "xmp"]);
const SKIPPED = new Set(["template", "svg", "math", "select", "button", "object", "datalist"]);
/** Void elements have no end tag: skipping "to the end tag" of a hidden <img> would skip the rest of the page. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** A line break before and after these, so paragraphs and list items don't run together. */
const BLOCK = new Set(
  "address article aside blockquote br dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tr ul".split(" "),
);

const TAG = /<(\/?)([a-zA-Z][^\s/>]*)([^>]*)>/y;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The page's text: tags, comments, scripts, styles and hidden elements removed, the common entities decoded,
 *  whitespace collapsed, at most `max` characters. Linear in the size of the page. */
export function plainText(html: string, max = MAX_CHARS): Markdown {
  const parts: string[] = [];
  let length = 0;
  let title: string | undefined;
  let truncated = false;
  const add = (text: string) => {
    const piece = length + text.length > max ? text.slice(0, max - length) : text;
    if (piece.length < text.length && text.slice(piece.length).trim()) truncated = true;
    parts.push(piece);
    length += piece.length;
  };
  /** Elements with no end tag after some point: they have none after any later point either, so searching again for
   *  each one (a page of unclosed <select>s) would only make the scan quadratic. */
  const unclosed = new Set<string>();
  let gt = -1; // the next ">", found once per stretch: a tag can't end before it

  let at = 0;
  while (at < html.length && !truncated) {
    const lt = html.indexOf("<", at);
    if (lt === -1) {
      add(decode(html.slice(at)));
      break;
    }
    if (lt > at) add(decode(html.slice(at, lt)));
    at = lt;
    if (html.startsWith("<!--", at)) {
      const end = html.indexOf("-->", at + 4);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    if (gt < at) gt = html.indexOf(">", at);
    if (gt === -1) {
      add(decode(html.slice(at))); // no tag can end anywhere after here: the rest is text
      break;
    }
    if (html[at + 1] === "!" || html[at + 1] === "?") {
      at = gt + 1; // a doctype, <![CDATA[, <?xml
      continue;
    }
    TAG.lastIndex = at;
    const tag = TAG.exec(html);
    if (!tag) {
      add("<"); // a lone "<" (as in "a < b") is text
      at++;
      continue;
    }
    at = TAG.lastIndex;
    const closing = tag[1] === "/";
    const name = tag[2]!.toLowerCase();
    if (BLOCK.has(name)) add("\n");
    else if (name === "td" || name === "th") add(" ");
    if (closing || VOID.has(name)) continue;

    if (RAW_TEXT.has(name) || SKIPPED.has(name)) {
      const end = unclosed.has(name) ? undefined : endTag(html, name, at, false);
      if (!end) unclosed.add(name);
      if (name === "title" && title === undefined) title = oneLine(decode(html.slice(at, end?.start ?? html.length)));
      if (end) at = end.end;
      else if (RAW_TEXT.has(name)) break; // raw text runs to the end of the page, as in a browser
    } else if (isHidden(tag[3]!)) {
      // Skipped with what it contains. Without an end tag, a hidden element hides the rest of the page: stopping
      // there is safe, and searching again for every unclosed one would make the scan quadratic.
      const end = endTag(html, name, at, true);
      if (!end) break;
      at = end.end;
    }
  }

  const text = parts
    .join("")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown: text, fallback: true, plain: true, ...(truncated ? { truncated } : {}) };
}

/** Where the element opened just before `from` ends: its end tag, counting nested ones of the same name if `nested`.
 *  Only the tag's name is matched, then the next ">" is found with indexOf: a pattern running on to the ">" would
 *  rescan the rest of the page for each "</div" without one. */
function endTag(html: string, name: string, from: number, nested: boolean): { start: number; end: number } | undefined {
  name = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // a page's tag name, inside a pattern
  const pattern = new RegExp(nested ? `<(/?)${name}(?=[\\s/>])` : `</${name}(?=[\\s/>])`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += nested && match[1] !== "/" ? 1 : -1;
    if (depth === 0) {
      const gt = html.indexOf(">", pattern.lastIndex);
      return { start: match.index, end: gt === -1 ? html.length : gt + 1 };
    }
  }
  return undefined;
}

function isHidden(attributes: string): boolean {
  ATTRIBUTE.lastIndex = 0;
  for (let match = ATTRIBUTE.exec(attributes); match; match = ATTRIBUTE.exec(attributes)) {
    const name = match[1]!.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name === "hidden" || (name === "aria-hidden" && value.toLowerCase() === "true") || (name === "style" && HIDDEN_STYLE.test(value))) return true;
  }
  return false;
}

function decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named]!;
    const code = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}
