// Skills: reusable instructions for specific tasks, as Markdown files.
//
//   .marv/skills/<name>/SKILL.md      (the project's skills)
//   ~/.marv/skills/<name>/SKILL.md    (your personal skills)
//
// Each SKILL.md starts with YAML frontmatter (name, description) followed by
// the instructions; the folder can hold extra files (scripts, references).
//
// Progressive disclosure: only each skill's name and description go into the
// system prompt. When the model decides one is relevant, it loads the full
// instructions with the `skill` tool. So many skills cost little until used,
// and the system prompt stays the same all session (good for the prompt cache).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Skill {
  name: string;
  description: string;
  /** The instructions (SKILL.md without its frontmatter). */
  body: string;
  /** Absolute path of the skill's folder. */
  dir: string;
  /** Other files in the folder, relative to it. */
  files: string[];
  source: "project" | "personal";
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_BODY_CHARS = 50_000;
const MAX_FILES = 50;

export const skillsDir = (base: string) => join(base, ".marv", "skills");

/** Everything in a skill folder except SKILL.md, relative and sorted. */
function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full !== join(dir, "SKILL.md")) files.push(relative(dir, full).split(sep).join("/"));
      if (files.length >= MAX_FILES) return;
    }
  };
  walk(dir);
  return files.sort();
}

/** Parses one SKILL.md; returns the skill, or a problem to report. */
async function readSkill(dir: string, folder: string, source: Skill["source"], shown: string): Promise<Skill | string> {
  const text = await Bun.file(join(dir, "SKILL.md")).text();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return `${shown} starts without a --- frontmatter block (name and description).`;

  let meta: unknown;
  try {
    meta = Bun.YAML.parse(match[1]!);
  } catch (err) {
    return `${shown}: the frontmatter isn't valid YAML (${(err as Error).message}).`;
  }
  const fields = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  const name = typeof fields.name === "string" ? fields.name.trim() : folder;
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!NAME.test(name)) return `${shown}: the name "${name}" should be lowercase letters, digits and dashes.`;
  if (!description) return `${shown} needs a description: it's how the model knows when to use the skill.`;

  let body = text.slice(match[0].length).trim();
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n\n(SKILL.md was cut off here: it's longer than ${MAX_BODY_CHARS} characters.)`;
  return { name, description, body, dir, files: listFiles(dir), source };
}

/** Loads personal skills, then project skills (which win on a name clash). Skips broken ones, saying why. */
export async function loadSkills({ root, home }: { root: string; home: string }): Promise<{ skills: Skill[]; problems: string[] }> {
  const byName = new Map<string, Skill>();
  const problems: string[] = [];
  const sources = [
    { base: home, source: "personal" as const, prefix: "~/" },
    { base: root, source: "project" as const, prefix: "" },
  ];
  for (const { base, source, prefix } of sources) {
    const dir = skillsDir(base);
    if (!existsSync(dir)) continue;
    for (const folder of readdirSync(dir).sort()) {
      const skillDir = join(dir, folder);
      if (!statSync(skillDir).isDirectory() || !existsSync(join(skillDir, "SKILL.md"))) continue;
      const result = await readSkill(skillDir, folder, source, `${prefix}.marv/skills/${folder}/SKILL.md`);
      if (typeof result === "string") problems.push(result);
      else byName.set(result.name, result);
    }
  }
  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** The user ran /<skill> <args>: one message with the skill's instructions and what they asked. */
export function skillMessage(skill: Skill, args: string): string {
  const files = skill.files.length ? `\n\n(Its files are in ${skill.dir}: ${skill.files.join(", ")}.)` : "";
  return `The user ran the "${skill.name}" skill. Follow its instructions:\n\n${skill.body}${files}\n\n${args ? `Their request: ${args}` : "They gave no further details."}`;
}
