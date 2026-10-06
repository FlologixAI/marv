import { describe, expect, test } from "bun:test";
import { draftLabel, draftPreview } from "../src/tool-draft.ts";

describe("draftLabel (what a tool call still streaming is about to do)", () => {
  test("names the file once its path has arrived", () => {
    expect(draftLabel("write_file", '{"path": "src/app.js", "content": "x')).toBe("Writing src/app.js…");
    expect(draftLabel("edit_file", '{"path":"a.ts","old_string":"')).toBe("Editing a.ts…");
    expect(draftLabel("write_file", '{"pa')).toBe("Writing a file…");
  });

  test("other tools", () => {
    expect(draftLabel("bash", '{"command": "bun te')).toBe("Writing a command…");
    expect(draftLabel("agent", "{")).toBe("Preparing agent…");
    expect(draftLabel("", "")).toBe("Preparing a tool call…");
  });

  test("an escaped path is decoded, and only the first line of a strange one is kept", () => {
    expect(draftLabel("write_file", '{"path": "dir/a \\"b\\".js"')).toBe('Writing dir/a "b".js…');
    expect(draftLabel("write_file", '{"path": "a\\nb"')).toBe("Writing a…");
  });
});

describe("draftPreview (the code written so far)", () => {
  test("write_file's content and edit_file's new_string, decoded while still unfinished", () => {
    expect(draftPreview("write_file", '{"path":"a.js","content":"const a = 1;\\nconst b = \\"x')).toBe('const a = 1;\nconst b = "x');
    expect(draftPreview("edit_file", '{"path":"a.js","old_string":"a","new_string":"if (x) {\\n\\treturn 1;')).toBe("if (x) {\n\treturn 1;");
    expect(draftPreview("bash", '{"command":"bun test && echo ok"}')).toBe("bun test && echo ok");
  });

  test("an escape cut in half isn't shown half-decoded", () => {
    expect(draftPreview("write_file", '{"content":"a\\')).toBe("a");
    expect(draftPreview("write_file", '{"content":"a\\u00')).toBe("a");
    expect(draftPreview("write_file", '{"content":"a\\u00e9b')).toBe("aéb");
  });

  test("nothing yet, or a tool without code: empty", () => {
    expect(draftPreview("write_file", '{"path":"a.js"')).toBe("");
    expect(draftPreview("read_file", '{"path":"a.js"}')).toBe("");
  });

  test("a complete value stops at its closing quote", () => {
    expect(draftPreview("write_file", '{"content":"done","path":"a.js"}')).toBe("done");
  });
});
