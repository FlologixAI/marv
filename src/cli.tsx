#!/usr/bin/env bun
// Entrypoint for the `ekko` command (see "bin" in package.json).
import { render } from "ink";
import pkg from "../package.json";
import { App } from "./app.tsx";
import { ConfigError, ConfigStore, defaultConfigDir } from "./config/config.ts";
import { shortenHome } from "./paths.ts";

const HELP = `ekko v${pkg.version}: a terminal coding agent

Usage:
  ekko              start an interactive session
  ekko --version    print the version
  ekko --help       show this help

Config:
  ~/.ekko/config.json   created by the setup screen (/setup to change it)
  ANTHROPIC_API_KEY     overrides the saved API key
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

const store = new ConfigStore(defaultConfigDir(process.env));
let initialFile;
try {
  initialFile = await store.load();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`${err.message}\n\nFix the file, or delete it to run setup again.`);
  process.exit(1);
}

// alternateScreen: draw on the terminal's separate full-screen buffer (like
// vim or htop). Your shell's screen is restored untouched when ekko exits.
// ctrl+c is handled inside the app (interrupt / clear / confirm exit).
const instance = render(
  <App store={store} initialFile={initialFile} env={process.env} version={pkg.version} cwd={shortenHome(process.cwd())} />,
  { exitOnCtrlC: false, alternateScreen: true },
);

await instance.waitUntilExit();
process.exit(0);
