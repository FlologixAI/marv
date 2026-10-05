import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { changeSummary, diffText } from "./diff.ts";
import { isDirectory, projectPath, requireRegularFile, resolveInProject } from "./files.ts";
import { ToolError, type Tool, type ToolContext } from "./types.ts";

const PREVIEW_LINES = 40;

const input = z.object({
  path: z.string().describe("File to write, relative to the project root. Folders are created as needed."),
  content: z.string().describe("The complete contents of the file."),
});

async function plan({ path, content }: z.infer<typeof input>, { root }: ToolContext) {
  const absolute = resolveInProject(root, path);
  const shown = projectPath(root, absolute);
  if (isDirectory(absolute)) throw new ToolError(`"${shown}" is a directory.`);
  const exists = existsSync(absolute);
  if (exists) requireRegularFile(absolute, shown);
  const before = exists ? await Bun.file(absolute).text() : null;
  return { absolute, shown, before, content };
}

const lineCount = (text: string) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

export const writeFile: Tool<typeof input> = {
  name: "write_file",
  description:
    "Create a new file, or replace a file's entire contents. For changing part of an existing file, use edit_file instead. " +
    "The user approves each change.",
  input,
  kind: "write",
  label: ({ path }) => path,
  scope: () => ({ key: "files", description: "file changes" }),

  async preview(args, ctx) {
    const { shown, before, content } = await plan(args, ctx);
    if (before === null) {
      const lines = content.replace(/\n$/, "").split("\n");
      return {
        title: `Create ${shown}`,
        diff: lines.slice(0, PREVIEW_LINES).map((text) => ({ kind: "add" as const, text })),
        note: lines.length > PREVIEW_LINES ? `${lines.length} lines (first ${PREVIEW_LINES} shown)` : undefined,
      };
    }
    return { title: `Overwrite ${shown}`, diff: diffText(before, content).lines };
  },

  async run(args, ctx) {
    const { absolute, shown, before, content } = await plan(args, ctx);
    await mkdir(dirname(absolute), { recursive: true });
    await Bun.write(absolute, content);
    if (before === null) {
      const n = lineCount(content);
      return { output: `Created ${shown} (${n} lines).`, summary: `created · ${n} line${n === 1 ? "" : "s"}` };
    }
    const diff = diffText(before, content);
    return { output: `Wrote ${shown} (${changeSummary(diff)} lines).`, summary: changeSummary(diff) };
  },
};
