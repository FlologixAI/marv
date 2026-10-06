import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { addedLines, changeSummary, diffText, shownDiff } from "./diff.ts";
import { lineEnding, withLineEnding } from "./edit-match.ts";
import { brokenBy, syntaxNote } from "./syntax.ts";
import { isDirectory, projectPath, refuseGit, requireRegularFile, resolveInProject, touchesGit } from "./files.ts";
import { ToolError, type Tool, type ToolContext } from "./types.ts";

const input = z.object({
  path: z.string().describe("File to write, relative to the project root. Folders are created as needed."),
  content: z.string().describe("The complete contents of the file."),
});

async function plan({ path, content }: z.infer<typeof input>, { root, confined }: ToolContext) {
  const absolute = resolveInProject(root, path);
  if (confined) refuseGit(root, absolute);
  const shown = projectPath(root, absolute);
  if (isDirectory(absolute)) throw new ToolError(`"${shown}" is a directory.`);
  const exists = existsSync(absolute);
  if (exists) requireRegularFile(absolute, shown);
  const before = exists ? await Bun.file(absolute).text() : null;
  // A model writes \n: rewriting a CRLF file would otherwise change every line, and its line endings with them.
  const crlf = before !== null && lineEnding(before) === "\r\n";
  return { absolute, shown, before, content: crlf ? withLineEnding(content, "\r\n") : content, crlf };
}

const lineCount = (text: string) => (text === "" ? 0 : text.replace(/\n$/, "").split("\n").length);

export const writeFile: Tool<typeof input> = {
  name: "write_file",
  description:
    "Create a new file, or replace a file's entire contents. For changing part of an existing file, use edit_file instead. " +
    "The user may be asked to approve each change.",
  input,
  kind: "write",
  label: ({ path }) => path,
  scope: () => ({ key: "files", description: "file changes" }),
  autoSafe: ({ path }, { root }) => !touchesGit(root, path),

  async preview(args, ctx) {
    const { shown, before, content } = await plan(args, ctx);
    // All of it: the prompt shows what fits and counts the rest (a preview is never saved).
    if (before === null) return { title: `Create ${shown}`, diff: addedLines(content) };
    return { title: `Overwrite ${shown}`, diff: diffText(before, content).lines };
  },

  async run(args, ctx) {
    const { absolute, shown, before, content, crlf } = await plan(args, ctx);
    await mkdir(dirname(absolute), { recursive: true });
    await Bun.write(absolute, content);
    const broken = await brokenBy(shown, before, content);
    const note = broken ? `\n\n${syntaxNote(shown, broken, content, before !== null)}` : "";
    if (before === null) {
      const n = lineCount(content);
      return { output: `Created ${shown} (${n} lines).${note}`, summary: `created · ${n} line${n === 1 ? "" : "s"}`, diff: shownDiff(addedLines(content)) };
    }
    const diff = diffText(before, content);
    return { output: `Wrote ${shown} (${changeSummary(diff)} lines${crlf ? "; kept its CRLF line endings" : ""}).${note}`, summary: changeSummary(diff), diff: shownDiff(diff.lines) };
  },
};
