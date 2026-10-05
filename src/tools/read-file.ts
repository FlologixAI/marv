import { existsSync } from "node:fs";
import { z } from "zod";
import { looksBinary, isDirectory, projectPath, requireRegularFile, resolveInProject } from "./files.ts";
import { ToolError, type Tool } from "./types.ts";

const DEFAULT_LIMIT = 400;
const MAX_LINE_CHARS = 500;

const input = z.object({
  path: z.string().describe("File path, relative to the project root (e.g. src/app.ts)."),
  offset: z.number().int().min(1).max(1_000_000).optional().describe("First line to read (1-based). Default 1."),
  limit: z.number().int().min(1).max(2000).optional().describe(`How many lines to read. Default ${DEFAULT_LIMIT}.`),
});

export const readFile: Tool<typeof input> = {
  name: "read_file",
  description:
    "Read a text file from the project. Returns lines prefixed with their line numbers. " +
    `Reads up to ${DEFAULT_LIMIT} lines at a time; use offset and limit to page through longer files.`,
  input,
  label: ({ path }) => path,

  async run({ path, offset = 1, limit = DEFAULT_LIMIT }, { root }) {
    const absolute = resolveInProject(root, path);
    const shown = projectPath(root, absolute);
    if (isDirectory(absolute)) throw new ToolError(`"${shown}" is a directory. Use glob to list its files.`);
    if (!existsSync(absolute)) throw new ToolError(`File not found: ${path}`);
    requireRegularFile(absolute, shown);
    const file = Bun.file(absolute);

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (looksBinary(bytes)) return { output: `Binary file (${bytes.length} bytes), not shown.`, summary: "binary file" };

    const text = new TextDecoder().decode(bytes);
    if (text === "") return { output: "(empty file)", summary: "empty" };
    const lines = text.replace(/\n$/, "").split("\n");
    const total = lines.length;
    if (offset > total) throw new ToolError(`${shown} has only ${total} lines; offset ${offset} is past the end.`);

    const end = Math.min(total, offset + limit - 1);
    const numbered = lines
      .slice(offset - 1, end)
      .map((line, i) => {
        const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (line truncated)` : line;
        return `${String(offset + i).padStart(5)}\t${clipped}`;
      })
      .join("\n");

    const partial = offset > 1 || end < total;
    const range = `lines ${offset}-${end} of ${total}`;
    const more = end < total ? ` Use offset=${end + 1} to read more.` : "";
    return {
      output: partial ? `${numbered}\n\n(Showing ${range}.${more})` : numbered,
      summary: partial ? range : `${total} line${total === 1 ? "" : "s"}`,
    };
  },
};
