import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, skillMessage } from "../src/skills.ts";
import { runTool } from "../src/tools/index.ts";

let root: string;
let home: string;

async function skill(base: string, folder: string, content: string, extra: Record<string, string> = {}) {
  const dir = join(base, ".marv", "skills", folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content);
  for (const [path, text] of Object.entries(extra)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

const md = (fields: string, body = "Do the thing.") => `---\n${fields}\n---\n\n${body}\n`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marv-skills-root-"));
  home = await mkdtemp(join(tmpdir(), "marv-skills-home-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("loadSkills", () => {
  test("reads name, description and instructions from the project and the home folder", async () => {
    await skill(root, "review", md("name: review\ndescription: Review code for bugs. Use when asked to review.", "# Review\n\n1. Read the diff."));
    await skill(home, "commit", md('name: commit\ndescription: "Write a commit message: imperative mood."'));
    const { skills, problems } = await loadSkills({ root, home });

    expect(problems).toEqual([]);
    expect(skills.map((s) => [s.name, s.source])).toEqual([
      ["commit", "personal"],
      ["review", "project"],
    ]);
    const review = skills.find((s) => s.name === "review")!;
    expect(review.description).toBe("Review code for bugs. Use when asked to review.");
    expect(review.body).toBe("# Review\n\n1. Read the diff."); // the frontmatter is not part of the instructions
  });

  test("a project skill overrides a personal one with the same name", async () => {
    await skill(home, "review", md("name: review\ndescription: personal version"));
    await skill(root, "review", md("name: review\ndescription: project version"));
    const { skills } = await loadSkills({ root, home });
    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe("project version");
  });

  test("lists the other files in a skill's folder", async () => {
    await skill(root, "pdf", md("name: pdf\ndescription: Work with PDFs."), { "scripts/extract.py": "print(1)", "reference.md": "# Ref" });
    const { skills } = await loadSkills({ root, home });
    expect(skills[0]!.files).toEqual(["reference.md", "scripts/extract.py"]);
  });

  test("the folder name is used when the name is missing", async () => {
    await skill(root, "tidy-up", md("description: Clean up imports."));
    expect((await loadSkills({ root, home })).skills[0]!.name).toBe("tidy-up");
  });

  test.each([
    ["no frontmatter", "Just text.", "starts without a --- frontmatter block"],
    ["no description", md("name: x"), "needs a description"],
    ["broken YAML", "---\nname: [unclosed\n---\nbody", "frontmatter isn't valid YAML"],
    ["bad name", md("name: Not Valid!\ndescription: d"), "lowercase letters, digits and dashes"],
  ])("skips a skill with %s, and says why", async (_case, content, problem) => {
    await skill(root, "broken", content);
    const { skills, problems } = await loadSkills({ root, home });
    expect(skills).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(problem);
    expect(problems[0]).toContain(".marv/skills/broken/SKILL.md");
  });

  test("no skills folders at all is fine", async () => {
    expect(await loadSkills({ root, home })).toEqual({ skills: [], problems: [] });
  });
});

describe("the skill tool", () => {
  test("loads a skill's instructions, and points to its files", async () => {
    await skill(home, "pdf", md("name: pdf\ndescription: Work with PDFs.", "Use scripts/extract.py."), { "scripts/extract.py": "print('hi')" });
    const { skills } = await loadSkills({ root, home });
    const result = await runTool({ id: "1", name: "skill", arguments: '{"name":"pdf"}' }, { root, skills });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("Use scripts/extract.py.");
    expect(result.output).toContain("scripts/extract.py");
    expect(result.output).toContain(join(home, ".marv", "skills", "pdf")); // where its files live, for bash
    expect(result.label).toBe("pdf");
  });

  test("reads a file from the skill's folder, but nothing outside it", async () => {
    await skill(home, "pdf", md("name: pdf\ndescription: Work with PDFs."), { "reference.md": "# Reference" });
    const { skills } = await loadSkills({ root, home });
    const file = await runTool({ id: "1", name: "skill", arguments: '{"name":"pdf","file":"reference.md"}' }, { root, skills });
    expect(file.output).toContain("# Reference");
    const escape = await runTool({ id: "2", name: "skill", arguments: '{"name":"pdf","file":"../../../config.json"}' }, { root, skills });
    expect(escape.isError).toBe(true);
  });

  test("an unknown skill lists the ones that exist", async () => {
    await skill(root, "review", md("name: review\ndescription: d"));
    const { skills } = await loadSkills({ root, home });
    const result = await runTool({ id: "1", name: "skill", arguments: '{"name":"nope"}' }, { root, skills });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("review");
  });
});

test("skillMessage puts the instructions and the user's arguments into one message", async () => {
  await skill(root, "review", md("name: review\ndescription: d", "Check for bugs."));
  const { skills } = await loadSkills({ root, home });
  const message = skillMessage(skills[0]!, "src/app.tsx");
  expect(message).toContain('the "review" skill');
  expect(message).toContain("Check for bugs.");
  expect(message).toEndWith("src/app.tsx");
});
