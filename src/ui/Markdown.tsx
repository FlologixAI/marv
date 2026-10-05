// Renders the model's Markdown as structured terminal output: lists with
// hanging indents, styled inline code and emphasis, code blocks behind a
// rule, aligned tables. `marked` parses the text into tokens (paragraph,
// list, code…); each token becomes Ink boxes, so wrapping and indentation
// come from the layout instead of from the raw text.
import { memo, useMemo, useRef, type ReactNode } from "react";
import { Box, Text } from "ink";
import { printable } from "../printable.ts";
import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import { theme } from "./theme.ts";

const BULLETS = ["•", "◦", "▪"];

/** A fixed-width column for a list marker or quote bar, so the text beside it wraps with a hanging indent. */
function Marker({ text, width, color }: { text: string; width: number; color?: string }) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={color}>{text}</Text>
    </Box>
  );
}

/** Inline tokens (text, `code`, **bold**, links…) as nested <Text>. */
function inline(tokens: Token[] | undefined): ReactNode[] {
  return (tokens ?? []).map((token, i) => {
    switch (token.type) {
      case "strong":
        return (
          <Text key={i} bold>
            {inline(token.tokens)}
          </Text>
        );
      case "em":
        return (
          <Text key={i} italic>
            {inline(token.tokens)}
          </Text>
        );
      case "del":
        return (
          <Text key={i} strikethrough>
            {inline(token.tokens)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={i} color={theme.code}>
            {token.text}
          </Text>
        );
      case "link": {
        const link = token as Tokens.Link;
        // A bare URL (autolink) is shown once; otherwise the text, then the target.
        if (link.text === link.href || `mailto:${link.text}` === link.href) {
          return (
            <Text key={i} color={theme.code} underline>
              {link.text}
            </Text>
          );
        }
        return (
          <Text key={i}>
            <Text underline>{inline(link.tokens)}</Text>
            <Text color={theme.dim}> ({link.href})</Text>
          </Text>
        );
      }
      case "image":
        return <Text key={i} color={theme.dim}>{`[image: ${(token as Tokens.Image).text}]`}</Text>;
      case "br":
        return "\n";
      case "checkbox":
        return null; // shown as the list marker instead
      case "text":
        return "tokens" in token && token.tokens ? <Text key={i}>{inline(token.tokens)}</Text> : token.text;
      default:
        // escape, html, and anything unexpected: show the text as-is.
        return "text" in token ? (token.text as string) : token.raw;
    }
  });
}

/** Plain text of inline tokens, for measuring table cells. */
function plain(tokens: Token[] | undefined): string {
  return (tokens ?? [])
    .map((token) => ("tokens" in token && token.tokens ? plain(token.tokens) : "text" in token ? String(token.text) : ""))
    .join("");
}

function List({ list, depth }: { list: Tokens.List; depth: number }) {
  const start = typeof list.start === "number" ? list.start : 1;
  const numberWidth = `${start + list.items.length - 1}.`.length;
  const width = list.ordered ? numberWidth + 1 : 2;

  return (
    <Box flexDirection="column">
      {list.items.map((item, i) => {
        const marker = item.task
          ? item.checked
            ? "☑"
            : "☐"
          : list.ordered
            ? `${start + i}.`.padStart(numberWidth)
            : BULLETS[depth % BULLETS.length]!;
        return (
          <Box key={i}>
            <Marker text={marker} width={width} color={list.ordered ? undefined : theme.dim} />
            <Box flexDirection="column" flexShrink={1}>
              <Blocks tokens={item.tokens} depth={depth + 1} gap={item.loose ? 1 : 0} />
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function Table({ table }: { table: Tokens.Table }) {
  const rows = [table.header, ...table.rows].map((row) => row.map((cell) => plain(cell.tokens)));
  const widths = table.header.map((_, col) => Math.max(...rows.map((row) => stringWidth(row[col] ?? ""))));
  const line = (cells: string[]) => cells.map((cell, col) => cell + " ".repeat(widths[col]! - stringWidth(cell))).join("  ").trimEnd();

  return (
    <Box flexDirection="column">
      <Text bold>{line(rows[0]!)}</Text>
      <Text color={theme.dim}>{widths.map((w) => "─".repeat(w)).join("  ")}</Text>
      {rows.slice(1).map((row, i) => (
        <Text key={i}>{line(row)}</Text>
      ))}
    </Box>
  );
}

function Block({ token, depth }: { token: Token; depth: number }) {
  switch (token.type) {
    case "paragraph":
      return <Text>{inline(token.tokens)}</Text>;
    case "text":
      // List items hold "text" blocks rather than paragraphs.
      return <Text>{"tokens" in token && token.tokens ? inline(token.tokens) : token.text}</Text>;
    case "heading":
      return (
        <Text bold color={theme.accent}>
          {inline(token.tokens)}
        </Text>
      );
    case "code": {
      const code = token as Tokens.Code;
      return (
        <Box flexDirection="column">
          {code.lang && <Text color={theme.dim}>{code.lang}</Text>}
          <Box borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={theme.dim} paddingLeft={1}>
            <Text color={theme.codeBlock}>{code.text}</Text>
          </Box>
        </Box>
      );
    }
    case "list":
      return <List list={token as Tokens.List} depth={depth} />;
    case "blockquote":
      return (
        <Box>
          <Marker text="▎" width={2} color={theme.dim} />
          <Box flexDirection="column" flexShrink={1}>
            <Blocks tokens={(token as Tokens.Blockquote).tokens} depth={depth} />
          </Box>
        </Box>
      );
    case "table":
      return <Table table={token as Tokens.Table} />;
    case "hr":
      return <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderColor={theme.dim} />;
    case "html":
      return <Text>{token.text}</Text>;
    default:
      return null;
  }
}

/** A run of block tokens, separated by `gap` blank lines (one between paragraphs; none in tight lists). */
function Blocks({ tokens, depth, gap = 1 }: { tokens: Token[]; depth: number; gap?: number }) {
  const blocks = tokens.filter((t) => t.type !== "space" && t.type !== "def");
  return (
    <Box flexDirection="column">
      {blocks.map((token, i) => (
        <Box key={i} marginTop={i > 0 ? gap : 0} flexDirection="column">
          <Block token={token} depth={depth} />
        </Box>
      ))}
    </Box>
  );
}

const lex = (text: string) => marked.lexer(text, { gfm: true });
/** A fence line: its run of ``` or ~~~ (3 or more), then the rest (a language, or nothing when it closes). */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A list item's first line: "- ", "* ", "+ ", "1. " or "1) ". */
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;

/**
 * Parses a reply as it streams in without re-parsing all of it each time:
 * parsing grows faster than the text (~20 ms at 11 KB, ~110 ms at 30 KB), and
 * streaming re-renders many times a second. Text only ever grows at the end,
 * so everything before the last finished block is parsed once and cached;
 * each update parses just the unfinished end.
 *
 * A block ends at a blank line that is outside a code fence and followed by
 * an unindented line (so a list item's indented continuation stays with it).
 * Splitting there can turn one "loose" list into two lists, which looks the
 * same; the finished reply is parsed whole anyway.
 */
export function createStreamLexer() {
  let done = ""; // the parsed prefix: always ends at a block boundary, outside any fence
  let doneTokens: Token[] = [];

  return (text: string): Token[] => {
    if (!text.startsWith(done)) {
      done = "";
      doneTokens = [];
    }
    // Find the last block boundary after the parsed prefix: a blank line outside any fence or HTML comment,
    // before a line that starts a new block (not an indented continuation, and not another item of a list: a
    // loose list split there would render as separate lists, and jump when the reply is parsed whole).
    let boundary = done.length;
    let fence: { char: string; length: number } | null = null;
    let inComment = false;
    let lineStart = done.length;
    for (let nl = text.indexOf("\n", lineStart); nl !== -1; nl = text.indexOf("\n", lineStart)) {
      const line = text.slice(lineStart, nl);
      const marker = FENCE.exec(line);
      if (fence) {
        // Closed only by the same character, at least as long, with nothing after it (```sh inside ````markdown,
        // or ```js after ```js, doesn't close it).
        if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && marker[2]!.trim() === "") fence = null;
      } else if (inComment) {
        if (line.includes("-->")) inComment = false;
      } else if (marker && !(marker[1]![0] === "`" && marker[2]!.includes("`"))) {
        // (A backtick fence's info string can't contain a backtick: "```x``` is…" is inline code, not a fence.)
        fence = { char: marker[1]![0]!, length: marker[1]!.length };
      } else if (/^ {0,3}<!--/.test(line) && !line.includes("-->")) {
        inComment = true;
      }
      // Only a complete next line can decide (cuts are cached for good): "3" still arriving may become "3. third".
      const nextEnd = text.indexOf("\n", nl + 1);
      const next = nextEnd === -1 ? null : text.slice(nl + 1, nextEnd);
      if (line.trim() === "" && !fence && !inComment && next && !/^\s/.test(next) && !LIST_ITEM.test(next)) boundary = nl + 1;
      lineStart = nl + 1;
    }
    if (boundary > done.length) {
      doneTokens = [...doneTokens, ...lex(text.slice(done.length, boundary))];
      done = text.slice(0, boundary);
    }
    return [...doneTokens, ...lex(text.slice(done.length))];
  };
}

/**
 * Markdown text as terminal output. Finished messages are parsed once;
 * `streaming` (the reply still coming in) parses incrementally.
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const streamLexer = useRef<ReturnType<typeof createStreamLexer> | null>(null);
  // Sanitized as a whole before lexing, so the lexer's cache sees one consistent text.
  // (An unfinished escape sequence at the end is dropped until it completes; the
  // lexer starts over if the text no longer extends what it cached.)
  const tokens = useMemo(() => {
    const clean = printable(text);
    if (!streaming) return lex(clean);
    streamLexer.current ??= createStreamLexer();
    return streamLexer.current(clean);
  }, [text, streaming]);
  return <Blocks tokens={tokens} depth={0} />;
});
