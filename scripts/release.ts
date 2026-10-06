// Builds the npm package into release/, ready for `npm pack ./release` or `npm publish ./release --access public`.
//
//   bun run release:build
//
// Why a separate folder instead of publishing the repository as it is:
//
// - The CLI needs its patched dependencies (patches/: Ink's selection hook and off-screen skipping, string-width's
//   cache, ink-text-input's ctrl+letter). Bun applies patches only in this repository, never in a project that
//   installs Marv, so the CLI is bundled: dist/cli.js holds Marv and every library it uses, copied from this
//   node_modules with the patches already applied.
// - The repository's package.json lists `patchedDependencies`, and Bun refuses to install a package that has it
//   (it looks for the patch files in the installing project). The published package.json is written here without it,
//   and without the scripts and devDependencies that only matter in a clone.
// - The SDK (`@flologixai/marv/sdk`) stays TypeScript source in src/, so its users get its types. It never imports
//   Ink or React, so it only needs the dependencies its own files import, which are found below rather than listed by
//   hand (a list would go stale the first time someone adds an import).
import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import pkg from "../package.json";

const OUT = "release";
const ROOT = join(import.meta.dir, "..");
const out = (...parts: string[]) => join(ROOT, OUT, ...parts);

rmSync(out(), { recursive: true, force: true });

// --- The CLI, bundled ---
// The converter web_fetch runs in its own process is a second entry point: src/tools/web/convert.ts finds it at
// dist/tools/web/html-convert-cli.js, beside the bundle.
// Ink connects to React DevTools only with DEV=true and react-devtools-core installed, but the bundle turns its import
// into one that runs at startup: left external, Marv fails to start wherever that package isn't installed (Bun only
// hides it by installing it on the fly when there's no node_modules). A stub that does nothing stands in for it.
const noDevtools: Bun.BunPlugin = {
  name: "no-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "export default { initialize() {}, connectToDevTools() {} };",
      loader: "js",
    }));
  },
};
const cli = await Bun.build({
  entrypoints: [join(ROOT, "src/cli.tsx"), join(ROOT, "src/tools/web/html-convert-cli.ts")],
  root: join(ROOT, "src"),
  outdir: out("dist"),
  target: "bun",
  plugins: [noDevtools],
  metafile: true,
});
if (!cli.success) fail("bundling the CLI failed:\n" + cli.logs.join("\n"));
// The bundle must stand alone: an import of a package would fail on every machine that doesn't happen to have it.
// Except OPTIONAL: linkedom (web_fetch's HTML parser) tries require("canvas") and falls back to a shim without it.
const OPTIONAL = ["canvas"];
const leftOver = new Set([...packagesImported(cli)].filter((name) => !OPTIONAL.includes(name)));
if (leftOver.size) fail(`the bundled CLI still imports ${[...leftOver].join(", ")}`);

// A bash launcher like bin/marv, pointed at the bundle: `exec -a` names the process "marv" rather than "bun".
mkdirSync(out("bin"));
writeFileSync(
  out("bin/marv"),
  `#!/usr/bin/env bash
# Launcher for \`marv\`: runs the bundled CLI under the process name "marv" (what ps and terminal tabs show).
here=$(dirname "$(realpath "$0")")
exec -a marv bun "$here/../dist/cli.js" "$@"
`,
);
chmodSync(out("bin/marv"), 0o755);

// --- The SDK, as source ---
cpSync(join(ROOT, "src"), out("src"), { recursive: true });
for (const file of ["README.md", "LICENSE"]) cpSync(join(ROOT, file), out(file));

// Which packages the SDK's files import: bundle them with every package left external (nothing is written: no
// outdir), then read the imports that remain. The converter counts too: the SDK runs it from src/. Type-only imports are erased, so a package the SDK
// needs only for its types is listed in TYPE_DEPENDENCIES.
const TYPE_DEPENDENCIES = ["@types/turndown"];
const sdk = await Bun.build({
  entrypoints: [join(ROOT, "src/sdk.ts"), join(ROOT, "src/tools/web/html-convert-cli.ts")],
  root: join(ROOT, "src"),
  target: "bun",
  packages: "external",
  metafile: true,
});
if (!sdk.success) fail("bundling the SDK failed:\n" + sdk.logs.join("\n"));
const imported = packagesImported(sdk);
const all: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
const dependencies: Record<string, string> = {};
for (const name of [...imported, ...TYPE_DEPENDENCIES].sort()) {
  if (all[name]) dependencies[name] = all[name];
  else fail(`the SDK imports ${name}, which package.json doesn't list`);
}

// --- package.json ---
const published = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  homepage: pkg.homepage,
  repository: pkg.repository,
  bugs: pkg.bugs,
  keywords: pkg.keywords,
  type: pkg.type,
  bin: { marv: "bin/marv" },
  exports: pkg.exports,
  engines: pkg.engines,
  dependencies,
};
writeFileSync(out("package.json"), JSON.stringify(published, null, 2) + "\n");

console.log(`Built ${OUT}/ (${pkg.name}@${pkg.version}).`);
console.log(`  SDK dependencies: ${Object.keys(dependencies).join(", ")}`);
console.log(`Check it with \`npm pack ./${OUT} --dry-run\`; publish with \`npm publish ./${OUT} --access public\`.`);

/** The packages (not Node's or Bun's built-in modules) a bundle still imports, from Bun's metafile. */
function packagesImported(build: Bun.BuildOutput): Set<string> {
  const found = new Set<string>();
  for (const input of Object.values(build.metafile?.inputs ?? fail("the build has no metafile"))) {
    for (const { path, external } of input.imports) {
      if (!external || path.startsWith(".") || /^(node|bun):/.test(path)) continue;
      const parts = path.split("/");
      const name = path.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
      if (!builtinModules.includes(name) && name !== "bun") found.add(name);
    }
  }
  return found;
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}
