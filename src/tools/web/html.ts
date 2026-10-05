// HTML to Markdown for web_fetch. Readability (the code behind Firefox's Reader View) keeps a page's main
// content and drops its menus, sidebars and footers, which would otherwise cost tokens on every fetch;
// turndown writes what's left as Markdown, with GitHub's tables. linkedom is the DOM they work on (Bun has none).
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/** With less text than this, Readability didn't find the page's content (a page built by JavaScript, a short one). */
const MIN_ARTICLE_CHARS = 200;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.use(gfm);
turndown.remove(["script", "style", "noscript", "template", "iframe"]);

export interface Markdown {
  title?: string;
  markdown: string;
  /** Readability found nothing, so this is the whole page. */
  fallback: boolean;
}

export function htmlToMarkdown(html: string, url: string): Markdown {
  // keepClasses: turndown reads a code block's language from its class (language-ts).
  const article = new Readability(parse(html, url), { keepClasses: true }).parse();
  const title = article?.title?.trim() || undefined;
  if (article?.content && (article.textContent ?? "").trim().length >= MIN_ARTICLE_CHARS) {
    return { title, markdown: tidy(turndown.turndown(article.content)), fallback: false };
  }
  const document = parse(html, url); // Readability changed the first one
  for (const el of document.querySelectorAll("nav, footer")) el.remove();
  return { title: title ?? (document.title.trim() || undefined), markdown: tidy(turndown.turndown(document.body ?? "")), fallback: true };
}

/** linkedom's document, with links and images made absolute (the model can fetch them) and inline images dropped (their data can be megabytes). */
function parse(html: string, url: string) {
  const { document } = parseHTML(html);
  for (const img of document.querySelectorAll('img[src^="data:"]')) img.remove();
  for (const [selector, attr] of [["a[href]", "href"], ["img[src]", "src"]] as const) {
    for (const el of document.querySelectorAll(selector)) {
      try {
        el.setAttribute(attr, new URL(el.getAttribute(attr) ?? "", url).href);
      } catch {
        // not a URL: leave it as it is
      }
    }
  }
  return document;
}

const tidy = (markdown: string) => markdown.replace(/\n{3,}/g, "\n\n").trim();
