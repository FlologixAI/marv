import { describe, expect, test } from "bun:test";
import { brokenBy, syntaxError, syntaxNote } from "../src/tools/syntax.ts";

describe("syntaxError", () => {
  test("finds a JS/TS syntax error, with its line and column (1-based)", async () => {
    expect(await syntaxError("a.ts", "export function f(x: number) {\n  return x +;\n}\n")).toMatchObject({ line: 2, column: 13 });
    expect(await syntaxError("a.js", "const a = 1;\nconst a = 2;\n")).toMatchObject({ message: expect.stringContaining("already been declared"), line: 2 });
  });

  test("TypeScript in a .js file is an error (a model wrote types into JavaScript)", async () => {
    expect(await syntaxError("server.js", "export function createServer(options: {port: number}) {}\n")).not.toBeNull();
  });

  test.each([
    ["a.ts", 'import data from "./d.json" with { type: "json" };\nexport const x = data satisfies object;\n'],
    ["a.ts", "await using res = getResource();\n"],
    ["a.ts", "@Component({})\nexport class A { @Input() accessor name = 1; #p = 1; has(o: object) { return #p in o; } }\n"],
    ["a.ts", "enum E { A = 1 }\nnamespace N { export const a = 1; }\nexport = N;\n"],
    ["a.tsx", "export const A = () => <div>{1}</div>;\nconst f = <T,>(x: T) => x;\n"],
    ["a.js", "export const A = () => <div className='a'>{1}</div>;\n"],
    ["a.cjs", "#!/usr/bin/env node\nmodule.exports = {};\nreturn;\n"],
    ["a.json", '{ "a": [1, 2] }\n'],
    ["a.yaml", "a: [1, 2]\nb: { c: 3 }\n"],
    ["notes.md", "# anything `goes`"],
  ])("valid %s is fine", async (path, text) => {
    expect(await syntaxError(path, text)).toBeNull();
  });

  test("JSON and YAML errors", async () => {
    expect(await syntaxError("a.json", '{\n  "a": 1,\n}\n')).not.toBeNull();
    expect(await syntaxError("a.yml", "a: [1, 2\nb: 3\n")).not.toBeNull();
  });

  test("JSON with comments isn't checked: tsconfig.json, .jsonc and VS Code's settings allow them", async () => {
    expect(await syntaxError("tsconfig.json", '{ // comment\n  "a": 1, }\n')).toBeNull();
    expect(await syntaxError("tsconfig.build.json", "{ /* c */ }")).toBeNull();
    expect(await syntaxError(".vscode/settings.json", "{ // c\n}")).toBeNull();
    expect(await syntaxError("x.jsonc", "{ // c\n}")).toBeNull();
  });

  test.if(Bun.which("python3") !== null)("Python, parsed without running it", async () => {
    expect(await syntaxError("a.py", "def f(:\n    pass\n")).toMatchObject({ line: 1 });
    expect(await syntaxError("a.py", "import os\nos.system('touch /tmp/marv-should-not-run')\n")).toBeNull();
  });

  test("a file too big to check quickly isn't checked", async () => {
    expect(await syntaxError("big.js", `${"x".repeat(3_000_000)} +`)).toBeNull();
  });
});

describe("brokenBy (only what the change broke)", () => {
  test("a file that parsed and doesn't now", async () => {
    expect(await brokenBy("a.js", "const a = 1;\n", "const a = ;\n")).not.toBeNull();
  });

  test("a file that didn't parse before isn't blamed on the change", async () => {
    expect(await brokenBy("a.js", "const a = ;\n", "const a = ;\nconst b = ;\n")).toBeNull();
  });

  test("a new file is checked", async () => {
    expect(await brokenBy("a.js", null, "const a = ;\n")).not.toBeNull();
  });
});

describe("syntaxNote", () => {
  test("names the file, the error, and shows the line like read_file", () => {
    const note = syntaxNote("src/a.ts", { message: "Unexpected token", line: 2, column: 13 }, "x\n  return x +;\n", true);
    expect(note).toContain("Marv: ");
    expect(note).toContain("src/a.ts");
    expect(note).toContain("line 2");
    expect(note).toContain("    2→  return x +;");
  });
});
