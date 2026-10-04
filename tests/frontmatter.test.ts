import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../src/frontmatter.ts";

describe("parseFrontmatter", () => {
  test("splits the YAML fields from the body", () => {
    expect(parseFrontmatter("---\nname: review\ndescription: Look for bugs.\n---\n\n# Review\n", "x.md")).toEqual({
      fields: { name: "review", description: "Look for bugs." },
      body: "# Review",
    });
  });

  test("a multi-line description (as in Claude Code agent files) is one string", () => {
    const parsed = parseFrontmatter("---\nname: r\ndescription: |\n  Line one.\n  <example>two</example>\n---\nBody", "x.md");
    expect(parsed).toEqual({ fields: { name: "r", description: "Line one.\n<example>two</example>\n" }, body: "Body" });
  });

  test("no frontmatter, or broken YAML, is an error naming the file", () => {
    expect(parseFrontmatter("# Just text", "a/SKILL.md")).toEqual({ error: expect.stringContaining("a/SKILL.md starts without") });
    expect(parseFrontmatter("---\nname: [unclosed\n---\n", "b.md")).toEqual({ error: expect.stringContaining("b.md: the frontmatter isn't valid YAML") });
  });
});
