// YAML frontmatter: the "---" block at the top of SKILL.md and agent files,
// holding fields like name and description, followed by the instructions.

export type Frontmatter = { fields: Record<string, unknown>; body: string } | { error: string };

/** `shown` is how the file is named in problems ("~/.marv/skills/x/SKILL.md"). */
export function parseFrontmatter(text: string, shown: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { error: `${shown} starts without a --- frontmatter block (name and description).` };
  let meta: unknown;
  try {
    meta = Bun.YAML.parse(match[1]!);
  } catch (err) {
    return { error: `${shown}: the frontmatter isn't valid YAML (${(err as Error).message}).` };
  }
  const fields = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  return { fields, body: text.slice(match[0].length).trim() };
}
