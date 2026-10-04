#!/usr/bin/env bun
// Entrypoint for the `marv` command (see "bin" in package.json).
import { render } from "ink";
import pkg from "../package.json";
import { App } from "./app.tsx";
import { ConfigError, ConfigStore, defaultConfigDir, migrateLegacyConfig } from "./config/config.ts";
import { filterMouseInput, MOUSE_OFF, MOUSE_ON } from "./mouse.ts";
import { shortenHome } from "./paths.ts";
import { loadInstructions } from "./prompt.ts";
import { renderOptions } from "./render-options.ts";
import { selection } from "./selection.ts";

const HELP = `Marv v${pkg.version}: a terminal coding agent

Usage:
  marv              start an interactive session
  marv --version    print the version
  marv --help       show this help

Config:
  ~/.marv/config.json   created by the setup screen (/setup to change it)
  OPENROUTER_API_KEY    overrides the saved OpenRouter key
  OLLAMA_HOST           where Ollama runs (default localhost:11434)
  MARV_MODEL            overrides the saved model
  MARV_CONFIG_DIR       use a different config directory`;

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

// The project is wherever Marv was started; the tools can't reach outside it.
const root = process.cwd();
const instructions = await loadInstructions(root);

// Marv was called Ekko: carry its config over (only for the default location).
if (!process.env.MARV_CONFIG_DIR) await migrateLegacyConfig();
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
// receiving mouse codes after Marv quits.
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
// Moving the selection highlight redraws the last frame instead of re-rendering.
selection.repaint = instance.repaint;

await instance.waitUntilExit();
process.exit(0);
