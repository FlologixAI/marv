// HTML to Markdown for web_fetch. Readability (the code behind Firefox's Reader View) keeps a page's main
// content and drops its menus, sidebars and footers, which would otherwise cost tokens on every fetch;
// turndown writes what's left as Markdown, with GitHub's tables. linkedom is the DOM they work on (Bun has none).
//
// Everything here is synchronous CPU work on a stranger's page, so two rules:
// - It's bounded: the page is cut to MAX_CHARS before Readability and turndown see it, and Readability is
//   skipped for pages too deep or too big for it (unbounded, a 5 MB page of links took over 4 minutes, and
//   2,000 nested divs 23 s). Even so, call it through convertHtml (convert.ts), which runs it in a Worker
//   with a timeout: on the main thread it would freeze the UI, ctrl+c included.
// - What the model gets is what a reader sees: hidden elements, form controls and scripts are removed, since
//   text hidden from people is the classic way to plant instructions for an agent.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { HIDDEN_STYLE, MAX_CHARS, oneLine } from "./plain.ts";

export { MAX_CHARS };

/** With less text than this, Readability didn't find the page's content (a page built by JavaScript, a short one). */
const MIN_ARTICLE_CHARS = 200;
/** Readability's cost grows with depth cubed (2,000 levels: 23 s); real pages stay well under 50. Deeper than this, structure is junk. */
const MAX_DEPTH = 200;
/** Readability takes about 1 s per 50k elements (it may make four passes); a bigger page goes to the fallback. */
const MAX_READABILITY_ELEMENTS = 50_000;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.use(gfm);
turndown.remove(["script", "style", "noscript", "template", "iframe"]);

/** Never shown to a reader, or not text: their content would only be noise (or a hiding place). A <form> isn't here:
 *  ASP.NET pages wrap the whole page in one, so only the controls inside it go. */
const DROP = "script, style, noscript, template, iframe, frame, object, embed, svg, math, canvas, input, select, textarea, button, datalist, dialog:not([open])";

export interface Markdown {
  /** One line, at most 200 characters (it goes into the `Fetched <url> · <title>` header). */
  title?: string;
  markdown: string;
  /** Readability found nothing (or the page was too deep or big for it), so this is the whole page. */
  fallback: boolean;
  /** The page had more than MAX_CHARS of content, and the rest was cut. */
  truncated?: boolean;
  /** Converting took too long (or failed), so this is the page's text with the tags stripped, not Markdown (convertHtml). */
  plain?: boolean;
}

type Doc = ReturnType<typeof parseHTML>["document"];
type El = Doc["documentElement"];

export function htmlToMarkdown(html: string, url: string): Markdown {
  const document = parse(html);
  if (!document.documentElement) return { markdown: "", fallback: true }; // linkedom found nothing at all
  clean(document, baseUrl(document, url));
  const tooDeep = measure(document.body).depth > MAX_DEPTH;
  if (tooDeep) flatten(document.body, MAX_DEPTH);
  const truncated = prune(document.body, MAX_CHARS) || undefined;
  const pageTitle = oneLine(document.querySelector("title")?.textContent);

  if (!tooDeep && measure(document.body).elements <= MAX_READABILITY_ELEMENTS) {
    const body = document.body.cloneNode(true) as El; // Readability takes apart the document it reads
    // keepClasses: turndown reads a code block's language from its class (language-ts). The serializer hands
    // back the node itself rather than HTML, which turndown would parse again (twice the time and memory).
    const article = new Readability<El>(document as never, { keepClasses: true, serializer: (node) => node as El }).parse();
    const title = oneLine(article?.title) ?? pageTitle;
    if (article?.content && (article.textContent ?? "").trim().length >= MIN_ARTICLE_CHARS) {
      return { title, markdown: toMarkdown(article.content), fallback: false, truncated };
    }
    return { title, markdown: toMarkdown(withoutChrome(body)), fallback: true, truncated };
  }
  return { title: pageTitle, markdown: toMarkdown(withoutChrome(document.body)), fallback: true, truncated };
}

/** linkedom's document. linkedom doesn't add the <html>, <head> and <body> that HTML lets a page leave out (a minified
 *  page, a fragment, plain text served as HTML), and without them it has no body or no document at all; wrapped in
 *  them, the content is found again. */
function parse(html: string): Doc {
  const { document } = parseHTML(html);
  if (document.documentElement?.tagName === "HTML" && document.body.childNodes.length > 0) return document;
  const inner = html.replace(/^\uFEFF?\s*(?:<!doctype[^>]*>)?\s*(?:<html[^>]*>)?/i, "");
  const wrapped = parseHTML(`<html><head></head><body>${inner}</body></html>`).document;
  for (const title of wrapped.body.querySelectorAll("title")) wrapped.head.append(title); // or it would be body text
  return wrapped;
}

/** Where relative links point: the page's <base href> if it has a usable one, else the page itself. */
function baseUrl(document: Doc, url: string): string {
  const href = document.querySelector("base[href]")?.getAttribute("href");
  if (href) {
    const base = absolute(href, url);
    if (base && (base.protocol === "http:" || base.protocol === "https:")) return base.href;
  }
  return url;
}

/** What a reader wouldn't see goes; links and images are made absolute (the model can fetch them). Schemes are checked
 *  on the parsed URL, so ` DATA:` and `JaVaScRiPt:` count. Images stay only on http(s) (a data: one can be megabytes),
 *  links on http(s) or mailto; other links keep their text. */
function clean(document: Doc, base: string): void {
  for (const el of document.querySelectorAll(DROP)) el.remove();
  for (const el of document.querySelectorAll("[hidden], [aria-hidden=true i], [style]")) {
    const style = el.getAttribute("style");
    if (style === null || HIDDEN_STYLE.test(style)) el.remove();
  }
  for (const img of document.querySelectorAll("img")) {
    const src = absolute(img.getAttribute("src"), base);
    if (src && (src.protocol === "http:" || src.protocol === "https:")) img.setAttribute("src", src.href);
    else img.remove();
  }
  for (const a of document.querySelectorAll("a[href]")) {
    const href = absolute(a.getAttribute("href"), base);
    if (href && (href.protocol === "http:" || href.protocol === "https:" || href.protocol === "mailto:")) a.setAttribute("href", href.href);
    else a.replaceWith(...a.childNodes);
  }
}

function absolute(href: string | null, base: string): URL | undefined {
  if (href === null) return undefined;
  try {
    return new URL(href, base);
  } catch {
    return undefined;
  }
}

/** The deepest nesting and the number of elements, in one walk (iterative: a recursive one could overflow the stack). */
function measure(root: El): { depth: number; elements: number } {
  let depth = 0;
  let elements = 0;
  const stack: [El, number][] = [[root, 1]];
  while (stack.length > 0) {
    const [el, d] = stack.pop()!;
    elements++;
    if (d > depth) depth = d;
    for (const child of el.children) stack.push([child as El, d + 1]);
  }
  return { depth, elements };
}

/** Elements at `limit` keep only their text: turndown recurses per level (20,000 levels overflow its stack) and checks
 *  each element's whole text, so its cost grows with depth squared. */
function flatten(root: El, limit: number): void {
  const stack: [El, number][] = [[root, 1]];
  while (stack.length > 0) {
    const [el, d] = stack.pop()!;
    if (d >= limit) {
      if (el.children.length > 0) el.textContent = el.textContent;
      continue;
    }
    for (const child of el.children) stack.push([child as El, d + 1]);
  }
}

/** Keeps the first `budget` characters of content and removes everything after it; true if anything was removed.
 *  Text counts as its length; each element as 1 plus its link or image URL, since those end up in the Markdown too
 *  (a page of links is mostly URLs) and an element costs turndown time even when it's empty. */
function prune(root: El, budget: number): boolean {
  let used = 0;
  let node = root.firstChild;
  while (node) {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      const cost = text.trim().length;
      if (used + cost > budget) {
        node.textContent = text.slice(0, budget - used); // one huge text node (a <pre> of logs) is cut too
        removeAfter(node, root);
        return true;
      }
      used += cost;
    } else if (node.nodeType === 1) {
      const el = node as El;
      const cost = 1 + (el.getAttribute("href")?.length ?? 0) + (el.getAttribute("src")?.length ?? 0);
      if (used + cost > budget) {
        removeAfter(node, root);
        node.remove();
        return true;
      }
      used += cost;
    }
    // Next in document order: first child, else the next sibling of the nearest ancestor that has one.
    if (node.firstChild) node = node.firstChild;
    else {
      while (node && node !== root && !node.nextSibling) node = node.parentNode;
      node = node && node !== root ? node.nextSibling : null;
    }
  }
  return false;
}

/** Removes everything after `node` in document order, inside `root`: its following siblings, then each ancestor's. */
function removeAfter(node: NonNullable<El["firstChild"]>, root: El): void {
  for (let at: typeof node | null = node; at && at !== root; at = at.parentNode) {
    while (at.nextSibling) at.nextSibling.remove();
  }
}

/** The whole page minus its menus and footer. */
function withoutChrome(body: El): El {
  for (const el of body.querySelectorAll("nav, footer")) el.remove();
  return body;
}

function toMarkdown(root: El): string {
  // A table without rows of its own (empty, cut by prune, or only a caption or a nested table) crashes the gfm
  // plugin, which reads the first row: it's unwrapped, so what it held is still converted.
  for (const table of root.querySelectorAll("table")) {
    if ((table as unknown as { rows: El[] }).rows.length === 0) table.replaceWith(...table.childNodes);
  }
  return turndown.turndown(root as never).replace(/\n{3,}/g, "\n\n").trim();
}

// The gfm plugin finds a table's header row through `table.rows[0]`, which linkedom doesn't implement (it has no
// table class at all: a <table> is a plain HTMLElement), so every table crashed it. Setting `rows` on each table
// wouldn't survive, since turndown converts a clone, so linkedom's HTMLElement gets it: on a table, the rows a
// browser would list (<thead> first, <tfoot> last, nested tables' rows not included); on anything else, nothing.
const elementProto = Object.getPrototypeOf(parseHTML("<p></p>").document.createElement("table"));
if (!("rows" in elementProto)) {
  Object.defineProperty(elementProto, "rows", {
    configurable: true,
    get(this: El) {
      if (this.tagName !== "TABLE") return undefined;
      const head: El[] = [];
      const body: El[] = [];
      const foot: El[] = [];
      for (const child of this.children) {
        if (child.tagName === "TR") body.push(child as El);
        const into = child.tagName === "THEAD" ? head : child.tagName === "TBODY" ? body : child.tagName === "TFOOT" ? foot : undefined;
        if (into) for (const tr of child.children) if (tr.tagName === "TR") into.push(tr as El);
      }
      return [...head, ...body, ...foot];
    },
  });
}
