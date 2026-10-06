import { describe, expect, test } from "bun:test";
import { applyEdit, closestLines, lineEnding, withLineEnding } from "../src/tools/edit-match.ts";

const edit = (text: string, oldString: string, newString: string, replaceAll = false) => applyEdit(text, oldString, newString, replaceAll);

describe("line endings", () => {
  test("a file is CRLF only when every line break is", () => {
    expect(lineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(lineEnding("a\nb\n")).toBe("\n");
    expect(lineEnding("a\r\nb\n")).toBe("\n"); // mixed: left as it is
    expect(lineEnding("one line")).toBe("\n");
  });

  test("withLineEnding converts LF to CRLF without doubling an existing one", () => {
    expect(withLineEnding("a\nb\r\nc", "\r\n")).toBe("a\r\nb\r\nc");
    expect(withLineEnding("a\r\nb", "\n")).toBe("a\r\nb"); // LF files are never touched
  });

  test("a CRLF file keeps CRLF in what an edit inserts", () => {
    // A model's edit put bare \n into a CRLF file; it then spent 6 steps repairing it (eval, 2026-10-06).
    const result = edit("a\r\nreturn x;\r\nb\r\n", "return x;", "if (!x) return 0;\nreturn x;");
    expect(result).toEqual({ text: "a\r\nif (!x) return 0;\r\nreturn x;\r\nb\r\n", count: 1 });
  });

  test("an old_string written with LF matches across a CRLF file's lines", () => {
    expect(edit("a\r\nb\r\nc\r\n", "a\nb", "x\ny")).toMatchObject({ text: "x\r\ny\r\nc\r\n", count: 1 });
  });
});

describe("exact matches", () => {
  test("come first, and replace_all replaces every one", () => {
    expect(edit("foo bar foo", "foo", "baz", true)).toMatchObject({ text: "baz bar baz", count: 2 });
    expect(edit("a  \nb", "a  \nb", "c")).toEqual({ text: "c", count: 1 });
  });

  test("more than one without replace_all is an error with the count", () => {
    expect(edit("x\nx\n", "x", "y")).toEqual({ error: "ambiguous", count: 2 });
  });

  test("$ in new_string is literal", () => {
    expect(edit("a", "a", "$&$1")).toMatchObject({ text: "$&$1" });
  });
});

describe("trailing whitespace", () => {
  test("is ignored when nothing matches exactly", () => {
    const file = "const a = {   \n  timeout: 30,    \n};\n";
    const result = edit(file, "const a = {\n  timeout: 30,\n};", "const a = {\n  timeout: 60,\n};");
    expect(result).toMatchObject({ text: "const a = {\n  timeout: 60,\n};\n", count: 1, fuzzy: "trailing-whitespace" });
  });

  test("a trailing newline in old_string still takes the line break with it", () => {
    expect(edit("a  \nb\nc\n", "a\nb\n", "x\n")).toMatchObject({ text: "x\nc\n" });
  });
});

describe("indentation", () => {
  const tabbed = "function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n";

  test("spaces where the file has tabs: matched, and new_string is re-indented with tabs", () => {
    const result = edit(tabbed, "    if (x) {\n        return 1;\n    }", "    if (x) {\n        return 2;\n    }\n    return 0;");
    expect(result).toMatchObject({ text: "function f() {\n\tif (x) {\n\t\treturn 2;\n\t}\n\treturn 0;\n}\n", fuzzy: "indentation" });
  });

  test("two-space indentation for a tab file works too", () => {
    expect(edit(tabbed, "  if (x) {\n    return 1;\n  }", "  if (x) {\n    return 3;\n  }")).toMatchObject({
      text: "function f() {\n\tif (x) {\n\t\treturn 3;\n\t}\n}\n",
    });
  });

  test("the whole block shifted by a constant amount (copied without its outer indentation)", () => {
    const file = "class A {\n    m() {\n        return 1;\n    }\n}\n";
    expect(edit(file, "m() {\n    return 1;\n}", "m() {\n    return 2;\n}")).toMatchObject({
      text: "class A {\n    m() {\n        return 2;\n    }\n}\n",
      fuzzy: "indentation",
    });
  });

  test("blank lines in new_string stay empty, without indentation", () => {
    expect(edit(tabbed, "  if (x) {\n    return 1;\n  }", "  if (x) {\n\n    return 1;\n  }")).toMatchObject({
      text: "function f() {\n\tif (x) {\n\n\t\treturn 1;\n\t}\n}\n",
    });
  });

  test("a first line copied from its code (no indentation), the rest one tab too deep: what read_file's old tab separator caused", () => {
    // Every model that failed the eval's tab task wrote this: the number's separator tab taken for indentation
    // on every line but the first, where copying started at the code (eval, 2026-10-06).
    const file = "function f() {\n\tconst a = 1;\n\treturn a;\n}\n";
    expect(edit(file, "const a = 1;\n\t\treturn a;", "const a = 2;\n\t\treturn a;")).toMatchObject({
      text: "function f() {\n\tconst a = 2;\n\treturn a;\n}\n",
      fuzzy: "indentation",
    });
  });

  test("indentation that doesn't map consistently isn't guessed at", () => {
    // Line 1 is 1 level too shallow, line 2 is 1 level too deep: no single shift explains it.
    const file = "a {\n    b\n    c\n    d\n}\n";
    expect(edit(file, "    b\n        c\n    d", "B\n        C\n    D")).toMatchObject({ error: "not_found" });
  });

  test("a fuzzy match that isn't unique is ambiguous, not a guess", () => {
    expect(edit("\tx();\n\ty();\n\tx();\n", "  x();", "  z();")).toEqual({ error: "ambiguous", count: 2 });
  });

  test("an old_string that's part of a line only matches exactly", () => {
    expect(edit("\tconst  x = 1;\n", "const x", "const y")).toMatchObject({ error: "not_found" });
  });
});

describe("closestLines (for the error when nothing matches)", () => {
  const file = ["function a() {", "  return 1;", "}", "", "function greet(name) {", "  return `Hello, ${name}!`;", "}"].join("\n");

  test("finds the window most like old_string, 1-based", () => {
    expect(closestLines(file, "function greet(person) {\n  return `Hi, ${person}!`;\n}")).toEqual({ start: 5, end: 7 });
  });

  test("nothing close enough: null", () => {
    expect(closestLines(file, "SELECT * FROM users WHERE id = 1;")).toBeNull();
  });

  test("an empty file or an empty old_string: null", () => {
    expect(closestLines("", "x")).toBeNull();
  });
});
