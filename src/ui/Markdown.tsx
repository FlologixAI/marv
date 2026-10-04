// Renders the model's Markdown as structured terminal output: lists with
// hanging indents, styled inline code and emphasis, code blocks behind a
// rule, aligned tables. `marked` parses the text into tokens (paragraph,
// list, code…); each token becomes Ink boxes, so wrapping and indentation
// come from the layout instead of from the raw text.
import { memo, useMemo, type ReactNode } from "react";
import { Box, Text } from "ink";
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

/** Markdown text as terminal output. Re-parsed when the text changes (e.g. while a reply streams in). */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => marked.lexer(text, { gfm: true }), [text]);
  return <Blocks tokens={tokens} depth={0} />;
});
