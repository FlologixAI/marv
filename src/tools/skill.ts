import { resolve, sep } from "node:path";
import { z } from "zod";
import { ToolError, type Tool } from "./types.ts";

const input = z.object({
  name: z.string().describe("The skill's name, from the list in the system prompt."),
  file: z.string().optional().describe("A file from the skill's folder to read instead, e.g. reference.md."),
});

export const skill: Tool<typeof input> = {
  name: "skill",
  description:
    "Load a skill: detailed instructions for a specific kind of task (the available skills are listed in the system prompt). " +
    "Load the matching skill before starting such a task, then follow it. Use `file` to read one of the skill's extra files.",
  input,
  label: ({ name, file }) => (file ? `${name}/${file}` : name),

  async run({ name, file }, { skills = [] }) {
    const found = skills.find((s) => s.name === name);
    if (!found) {
      const names = skills.map((s) => s.name).join(", ") || "none";
      throw new ToolError(`There's no skill called "${name}". Available skills: ${names}.`);
    }

    if (file) {
      const path = resolve(found.dir, file);
      if (!path.startsWith(found.dir + sep)) {
        throw new ToolError(`"${file}" is outside the ${name} skill's folder.`);
      }
      const handle = Bun.file(path);
      if (!(await handle.exists())) throw new ToolError(`The ${name} skill has no file "${file}". Its files: ${found.files.join(", ") || "none"}.`);
      const text = await handle.text();
      return { output: text, summary: `${text.split("\n").length} lines` };
    }

    const files = found.files.length
      ? `\n\n---\nThis skill's folder is ${found.dir}. Its files: ${found.files.join(", ")}. ` +
        `Read one with skill {"name": "${name}", "file": "..."}; scripts can be run with bash from that folder.`
      : "";
    return { output: `${found.body}${files}`, summary: "loaded" };
  },
};

