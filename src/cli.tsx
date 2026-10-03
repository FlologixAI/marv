#!/usr/bin/env bun
// Entrypoint for the `ekko` command (see "bin" in package.json).
import { homedir } from "node:os";
import { render } from "ink";
import pkg from "../package.json";
import { App } from "./app.tsx";
import { EchoProvider } from "./provider/echo.ts";

const HELP = `ekko v${pkg.version}: a terminal coding agent

Usage:
  ekko              start an interactive session
  ekko --version    print the version
  ekko --help       show this help`;

function shortenHome(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

// ctrl+c is handled inside the app (interrupt / clear / confirm exit).
const instance = render(<App provider={new EchoProvider()} version={pkg.version} cwd={shortenHome(process.cwd())} />, {
  exitOnCtrlC: false,
});

await instance.waitUntilExit();
process.exit(0);
