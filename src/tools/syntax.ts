// After a file change, does the file still parse? edit_file and write_file add a note when a change broke it, so
// the model finds out in the same step instead of a few steps later from a failing test (or never: in a third of
// the eval runs the model didn't run anything after its last edit).
//
// Parsing must never run the file's code. That rules out Bun's own transpiler: Bun.Transpiler (transformSync and
// scan alike) executes macros (`import { x } from "./m.ts" with { type: "macro" }`), so checking a file a model
// wrote, or one in a cloned repository, would run it unsandboxed. @babel/parser only parses; JSON.parse and
// Bun.YAML.parse only parse; Python's ast.parse compiles to a tree without executing anything.
import { parse, type ParserPlugin } from "@babel/parser";
import { basename } from "node:path";
import { numberedLine } from "./read-file.ts";

export interface SyntaxProblem {
  message: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
}

/** Bigger than this isn't checked: a parse should take milliseconds, and a file this size is likely generated. */
const MAX_CHARS = 2_000_000;
const PYTHON_TIMEOUT_MS = 5_000;

const DECORATORS: ParserPlugin[] = ["decorators-legacy", "decoratorAutoAccessors", "explicitResourceManagement"];
const JS_PLUGINS: Record<string, ParserPlugin[]> = {
  ts: ["typescript", ...DECORATORS],
  mts: ["typescript", ...DECORATORS],
  cts: ["typescript", ...DECORATORS],
  tsx: ["typescript", "jsx", ...DECORATORS],
  // JSX in .js files is common (React projects), and allowing it costs nothing for plain JavaScript.
  js: ["jsx", ...DECORATORS],
  mjs: ["jsx", ...DECORATORS],
  cjs: ["jsx", ...DECORATORS],
  jsx: ["jsx", ...DECORATORS],
};

/** JSON files that may have comments and trailing commas (JSONC), which JSON.parse rejects. */
const isJsonc = (path: string) => /^(tsconfig|jsconfig)(\..*)?\.json$/.test(basename(path)) || path.endsWith(".jsonc") || /(^|\/)\.vscode\//.test(path);

function parseJs(text: string, plugins: ParserPlugin[]): SyntaxProblem | null {
  try {
    parse(text, {
      sourceType: "unambiguous",
      plugins,
      // Scripts, CommonJS and module fragments are all fine: only the syntax is being checked.
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
    });
    return null;
  } catch (err) {
    const { message, loc } = err as { message: string; loc?: { line: number; column: number } };
    return { message: message.replace(/ \(\d+:\d+\)$/, ""), line: loc?.line, column: loc ? loc.column + 1 : undefined };
  }
}

async function parsePython(text: string): Promise<SyntaxProblem | null> {
  const python = Bun.which("python3");
  if (!python) return null;
  // -I: no environment variables, no user site-packages, not the current folder on the path. ast.parse only builds
  // a tree; the file's code never runs.
  const script =
    "import ast, json, sys\ntry:\n    ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n    print(json.dumps({'message': e.msg, 'line': e.lineno, 'column': e.offset}))\n";
  const proc = Bun.spawn([python, "-I", "-c", script], { stdin: new TextEncoder().encode(text), stdout: "pipe", stderr: "ignore", cwd: "/", env: {} });
  const timer = setTimeout(() => proc.kill("SIGKILL"), PYTHON_TIMEOUT_MS);
  try {
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out ? (JSON.parse(out) as SyntaxProblem) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The file's syntax error, by its extension; null if it parses, or isn't a kind Marv checks. */
export async function syntaxError(path: string, text: string): Promise<SyntaxProblem | null> {
  if (text.length > MAX_CHARS) return null;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const plugins = JS_PLUGINS[ext];
  if (plugins) return parseJs(text, plugins);
  try {
    if (ext === "json") {
      if (!isJsonc(path)) JSON.parse(text);
      return null;
    }
    if (ext === "yaml" || ext === "yml") {
      Bun.YAML.parse(text);
      return null;
    }
  } catch (err) {
    return { message: (err as Error).message };
  }
  if (ext === "py") return parsePython(text);
  return null;
}

/**
 * A syntax error the change introduced: the file parsed before (or is new) and doesn't now. One that was already
 * there isn't the change's doing, and a parser that disagrees with the project (an unusual syntax plugin) would
 * otherwise complain about every edit to that file.
 */
export async function brokenBy(path: string, before: string | null, after: string): Promise<SyntaxProblem | null> {
  const now = await syntaxError(path, after);
  if (!now || (before !== null && (await syntaxError(path, before)))) return null;
  return now;
}

/** What the model is told, after the edit's own result. */
export function syntaxNote(shown: string, problem: SyntaxProblem, after: string, existed: boolean): string {
  const where = problem.line ? ` at line ${problem.line}${problem.column ? `, column ${problem.column}` : ""}` : "";
  const line = problem.line ? after.split(/\r?\n/)[problem.line - 1] : undefined;
  return (
    `Marv: ${shown} ${existed ? "doesn't parse any more after this change" : "doesn't parse"}: ${problem.message}${where}.` +
    `${line !== undefined ? `\n${numberedLine(problem.line!, line.length > 500 ? `${line.slice(0, 500)}…` : line)}` : ""}` +
    "\nFix it before going on (if you're sure the syntax is valid for this project, ignore this)."
  );
}
