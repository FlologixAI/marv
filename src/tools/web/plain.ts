// The plain-text fallback for a page too complex to convert in time, and the limits both conversions share. This runs
// on the main thread (after the converter was killed), on HTML that just proved hostile or pathological, and an
// attacker can make a page slow on purpose to land here, so:
// - It's one linear pass. Tags are read by hand, character by character, and searches only move forward (indexOf,
//   sticky or global regexes resumed where they stopped); never a pattern that could backtrack over the rest of the
//   page (a `<script[\s\S]*?<\/script>` replace is quadratic on a page of unclosed <script> tags).
// - It hides what the Markdown path hides: hidden elements, form controls, scripts. Quoted attribute values are
//   skipped as a browser does, so `<div title="x>" hidden>` is still one hidden tag.
import type { Markdown } from "./html.ts";

/** About ten of web_fetch's 30k-character pages: more is rarely read, and turndown slows down faster than its output grows. */
export const MAX_CHARS = 300_000;
const MAX_TITLE = 200;

/** Hidden by an inline style (`opacity: .0` too). Stylesheets aren't evaluated, so a class that hides text gets through. */
const HIDDEN_STYLE =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*(?:0+(?:\.0*)?|\.0+)|font-size\s*:\s*(?:0+(?:\.0*)?|\.0+)[a-z%]*)\s*(?:!important\s*)?(?:;|$)/i;

/** Whether an inline style (its entities already decoded) hides the element. CSS comments are removed first, since a
 *  comment between `display:` and `none` hides as well; by hand, since a lazy regex for comments is quadratic on a style
 *  full of unclosed ones. */
export function isHiddenStyle(style: string): boolean {
  let css = "";
  for (let at = 0; at < style.length; ) {
    const open = style.indexOf("/*", at);
    if (open === -1) {
      css += style.slice(at);
      break;
    }
    css += style.slice(at, open);
    const close = style.indexOf("*/", open + 2);
    if (close === -1) break; // an unclosed comment runs to the end
    at = close + 2;
  }
  return HIDDEN_STYLE.test(css);
}

/** One line (a newline in the title could forge a line of web_fetch's `Fetched <url> · <title>` header), at most 200 characters. */
export function oneLine(text: string | null | undefined): string | undefined {
  const line = (text ?? "").slice(0, MAX_TITLE * 10).replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (!line) return undefined;
  const chars = Array.from(line); // by code point, so an emoji isn't cut in half
  return chars.length > MAX_TITLE ? `${chars.slice(0, MAX_TITLE - 1).join("").trimEnd()}…` : line;
}

/** Raw text in HTML: no tags inside, only the end tag ends it (an unclosed <script> swallows the rest of the page in
 *  a browser too). */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "noscript", "iframe", "noembed", "noframes", "xmp"]);
/** Never text a reader sees: skipped with everything in them, like a hidden element. */
const SKIPPED = new Set(["template", "svg", "math", "select", "button", "object", "datalist"]);
/** No end tag, so a hidden <img> hides nothing after it. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/** A blank line before and after these, so paragraphs and list items don't run together. */
const BLOCK = new Set(
  "address article aside blockquote dd details div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tr ul".split(" "),
);

const ENTITY = /&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z]{2,8});)/g;
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", shy: "",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»",
  ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·", prime: "′", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×", divide: "÷", micro: "µ", para: "¶", sect: "§",
  euro: "€", pound: "£", yen: "¥", cent: "¢", larr: "←", rarr: "→", uarr: "↑", darr: "↓",
  aacute: "á", agrave: "à", acirc: "â", auml: "ä", aring: "å", ccedil: "ç", eacute: "é", egrave: "è", ecirc: "ê",
  euml: "ë", iacute: "í", iuml: "ï", ntilde: "ñ", oacute: "ó", ocirc: "ô", ouml: "ö", oslash: "ø", uacute: "ú",
  uuml: "ü", szlig: "ß", Aacute: "Á", Auml: "Ä", Eacute: "É", Ouml: "Ö", Uuml: "Ü",
};

interface Tag {
  name: string;
  closing: boolean;
  hidden: boolean;
  /** Just after the tag's `>`, or -1 if the page ends inside the tag (an unclosed quote). */
  end: number;
}

/** The page's text: tags, comments, scripts, styles and hidden elements removed, entities decoded, whitespace
 *  collapsed, at most `max` characters. Linear in the size of the page. */
export function plainText(html: string, max = MAX_CHARS): Markdown {
  const out = new Text(max);
  let title: string | undefined;
  /** Inside an element whose content is skipped (hidden, or one of SKIPPED): its name, and how many are open. */
  let skipping: { name: string; depth: number } | undefined;

  let at = 0;
  while (at < html.length && !out.truncated) {
    const lt = html.indexOf("<", at);
    const textEnd = lt === -1 ? html.length : lt;
    if (!skipping && textEnd > at) out.text(decode(html.slice(at, textEnd)));
    if (lt === -1) break;
    at = lt;
    if (html.startsWith("<!--", at)) {
      const end = html.indexOf("-->", at + 4);
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[at + 1] === "!" || html[at + 1] === "?") {
      const end = html.indexOf(">", at); // a doctype, <![CDATA[, <?xml: they end at the first ">"
      at = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = readTag(html, at);
    if (!tag) {
      if (!skipping) out.text("<"); // a lone "<" (as in "a < b") is text
      at++;
      continue;
    }
    if (tag.end === -1) break; // the page ends inside a tag: a browser shows none of it
    at = tag.end;
    const { name, closing } = tag;

    if (skipping) {
      // A <p> can't contain a block, so one starting ends it (HTML lets a page leave </p> out).
      if (!closing && skipping.name === "p" && BLOCK.has(name)) skipping = undefined;
      else if (name === skipping.name && !VOID.has(name) && (skipping.depth += closing ? -1 : 1) === 0) skipping = undefined;
    }
    if (!skipping) {
      if (BLOCK.has(name)) out.paragraph();
      else if (name === "br") out.line();
      else if (name === "td" || name === "th") out.text(" ");
    }
    if (closing || VOID.has(name)) continue;
    if (RAW_TEXT.has(name)) {
      const end = endOfRawText(html, name, at);
      if (name === "title" && title === undefined && !skipping) title = oneLine(decode(html.slice(at, end?.start ?? html.length)));
      if (!end) break;
      at = end.end;
    } else if (!skipping && (SKIPPED.has(name) || tag.hidden)) {
      // Without an end tag, everything after it is skipped: that's safe, and still one pass.
      skipping = { name, depth: 1 };
    }
  }
  return { title, markdown: out.toString(), fallback: true, plain: true, ...(out.truncated ? { truncated: true } : {}) };
}

/** The tag starting at `html[at] === "<"`, read as a browser does: its name, then attributes whose quoted values may
 *  contain ">". Undefined if this "<" doesn't start a tag. Each character is looked at once. */
function readTag(html: string, at: number): Tag | undefined {
  let i = at + 1;
  const closing = html[i] === "/";
  if (closing) i++;
  if (!isLetter(html.charCodeAt(i))) return undefined;
  const nameStart = i;
  while (i < html.length && !isSpace(html.charCodeAt(i)) && html[i] !== "/" && html[i] !== ">") i++;
  const name = html.slice(nameStart, i).toLowerCase();
  let hidden = false;
  for (;;) {
    while (i < html.length && (isSpace(html.charCodeAt(i)) || html[i] === "/")) i++;
    if (i >= html.length) return { name, closing, hidden, end: -1 };
    if (html[i] === ">") return { name, closing, hidden, end: i + 1 };
    const attrStart = i++; // an attribute's name can start with anything, even "=" or a quote
    while (i < html.length && !isSpace(html.charCodeAt(i)) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    const attr = html.slice(attrStart, i).toLowerCase();
    while (i < html.length && isSpace(html.charCodeAt(i))) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < html.length && isSpace(html.charCodeAt(i))) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        if (close === -1) return { name, closing, hidden, end: -1 };
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !isSpace(html.charCodeAt(i)) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    if (!hidden && !closing) hidden = attr === "hidden" || (attr === "aria-hidden" && decode(value).trim().toLowerCase() === "true") || (attr === "style" && isHiddenStyle(decode(value)));
  }
}

/** Where raw text opened just before `from` ends: the start and end of its end tag, or undefined if it never ends.
 *  Only the name is matched, then the ">" found with indexOf (a pattern running on to the ">" would rescan the rest
 *  of the page for each "</script" without one). */
function endOfRawText(html: string, name: string, from: number): { start: number; end: number } | undefined {
  const pattern = new RegExp(`</${name}(?=[\\s/>])`, "gi"); // `name` is one of RAW_TEXT
  pattern.lastIndex = from;
  const match = pattern.exec(html);
  if (!match) return undefined;
  const gt = html.indexOf(">", pattern.lastIndex);
  return { start: match.index, end: gt === -1 ? html.length : gt + 1 };
}

/** The text so far, whitespace collapsed as it comes in, so a run of spaces or empty blocks doesn't use the budget. */
class Text {
  private parts: string[] = [];
  private length = 0;
  private space = true; // the last character written is whitespace (or nothing is written yet)
  private newlines = 2;
  truncated = false;

  constructor(private readonly max: number) {}

  text(raw: string): void {
    let text = raw.replace(/\s+/g, " ");
    if (this.space && text.startsWith(" ")) text = text.slice(1);
    if (!text) return;
    if (this.length + text.length > this.max) {
      text = text.slice(0, this.max - this.length);
      this.truncated = true;
    }
    this.push(text);
    this.space = text.endsWith(" ");
    this.newlines = 0;
  }

  /** A blank line, unless there is one already. */
  paragraph(): void {
    while (this.newlines < 2) this.line();
  }

  line(): void {
    if (this.newlines >= 2) return;
    if (this.space && this.newlines === 0 && this.length > 0) {
      const last = this.parts.length - 1;
      this.parts[last] = this.parts[last]!.slice(0, -1); // no space at the end of a line
      this.length--;
    }
    this.push("\n");
    this.space = true;
    this.newlines++;
  }

  private push(piece: string): void {
    this.parts.push(piece);
    this.length += piece.length;
  }

  toString(): string {
    return this.parts.join("").trim();
  }
}

function decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
    if (named) return NAMED[named] ?? NAMED[named.toLowerCase()] ?? whole;
    const code = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

const isLetter = (code: number) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;
