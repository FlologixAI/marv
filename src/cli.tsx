#!/usr/bin/env bun
// Entrypoint for the `ekko` command (see "bin" in package.json).
import { render } from "ink";
import pkg from "../package.json";
import { App } from "./app.tsx";
import { ConfigError, ConfigStore, defaultConfigDir } from "./config/config.ts";
import { filterMouseInput, MOUSE_OFF, MOUSE_ON } from "./mouse.ts";
import { shortenHome } from "./paths.ts";
import { loadInstructions } from "./prompt.ts";
import { renderOptions } from "./render-options.ts";

const HELP = `ekko v${pkg.version}: a terminal coding agent

Usage:
  ekko              start an interactive session
  ekko --version    print the version
  ekko --help       show this help

Config:
  ~/.ekko/config.json   created by the setup screen (/setup to change it)
  OPENROUTER_API_KEY    overrides the saved OpenRouter key
  OLLAMA_HOST           where Ollama runs (default localhost:11434)
  EKKO_MODEL            overrides the saved model
  EKKO_CONFIG_DIR       use a different config directory`;

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

// The project is wherever ekko was started; the tools can't reach outside it.
const root = process.cwd();
const instructions = await loadInstructions(root);

const store = new ConfigStore(defaultConfigDir(process.env));
let initialFile;
try {
  initialFile = await store.load();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`${err.message}\n\nFix the file, or delete it to run setup again.`);
  process.exit(1);
}

// Mouse wheel scrolling and drag-to-select (see src/mouse.ts, src/selection.ts). Mouse reporting is a terminal-wide
// mode, so it must be switched off on every way out, or the shell would start
// receiving mouse codes after ekko quits.
if (process.stdin.isTTY && process.stdout.isTTY) {
  filterMouseInput(process.stdin);
  process.stdout.write(MOUSE_ON);
  process.on("exit", () => process.stdout.write(MOUSE_OFF));
}

const instance = render(
  <App
    store={store}
    initialFile={initialFile}
    env={process.env}
    version={pkg.version}
    cwd={shortenHome(root)}
    root={root}
    instructions={instructions}
  />,
  renderOptions,
);

await instance.waitUntilExit();
process.exit(0);
