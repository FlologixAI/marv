import { z } from "zod";
import { changeSummary, diffText } from "./diff.ts";
import { isDirectory, projectPath, resolveInProject } from "./files.ts";
import { ToolError, type Tool, type ToolContext } from "./types.ts";

const input = z.object({
  path: z.string().describe("File to edit, relative to the project root."),
  old_string: z.string().min(1).describe("The exact text to replace, copied from the file including whitespace and indentation."),
  new_string: z.string().describe("What to replace it with."),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of exactly one."),
});
type Input = z.infer<typeof input>;

/** The file before and after, or a ToolError the model can act on. Used for the preview and again when applying. */
async function plan({ path, old_string, new_string, replace_all }: Input, { root }: ToolContext) {
  const absolute = resolveInProject(root, path);
  const shown = projectPath(root, absolute);
  if (isDirectory(absolute)) throw new ToolError(`"${shown}" is a directory.`);
  const file = Bun.file(absolute);
  if (!(await file.exists())) throw new ToolError(`File not found: ${shown}. Use write_file to create a new file.`);
  const before = await file.text();

  const count = before.split(old_string).length - 1;
  if (count === 0) {
    throw new ToolError(
      `old_string was not found in ${shown}. It must match the file exactly, including whitespace and indentation. Use read_file to see the current text, then try again.`,
    );
  }
  if (count > 1 && !replace_all) {
    throw new ToolError(
      `old_string appears ${count} times in ${shown}. Include more of the surrounding lines so it matches exactly once, or set replace_all to change all ${count}.`,
    );
  }
  const after = replace_all ? before.replaceAll(old_string, new_string) : before.replace(old_string, () => new_string);
  return { absolute, shown, before, after, count: replace_all ? count : 1 };
}

export const editFile: Tool<typeof input> = {
  name: "edit_file",
  description:
    "Change part of a file by replacing exact text: old_string must match the file exactly once (copy it from read_file, " +
    "with its whitespace and indentation, and include enough lines to be unique), or set replace_all. " +
    "Prefer this over write_file for existing files. The user approves each change.",
  input,
  kind: "write",
  label: ({ path }) => path,
  scope: () => ({ key: "files", description: "file changes" }),

  async preview(args, ctx) {
    const { shown, before, after } = await plan(args, ctx);
    return { title: `Edit ${shown}`, diff: diffText(before, after).lines };
  },

  async run(args, ctx) {
    // Planned again: the file may have changed while the user was deciding.
    const { absolute, shown, before, after, count } = await plan(args, ctx);
    await Bun.write(absolute, after);
    const diff = diffText(before, after);
    return {
      output: `Edited ${shown}: replaced ${count} occurrence${count === 1 ? "" : "s"} (${changeSummary(diff)} lines).`,
      summary: changeSummary(diff),
    };
  },
};
