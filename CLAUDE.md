# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`ekko` is a terminal coding agent (like Claude Code) written in TypeScript on **Bun** with an **Ink** (React-for-terminal) TUI. It is being built milestone by milestone; the roadmap lives in `~/.claude/plans/im-planning-on-making-staged-eclipse.md`. The owner is learning how agents work, so explain the *why* of each change.

## Commands

```sh
bun install
bun run dev                 # run the TUI from source (same as `ekko`)
bun test                    # all tests
bun test tests/commands     # one file (path substring filter)
bun test -t "echoes"        # tests whose name matches
bun run typecheck           # tsc --noEmit
bun link                    # (once) puts `ekko` on PATH, pointing at src/cli.tsx — no build step
```

## Architecture

- `src/cli.tsx` is the `bin` entry (Bun shebang). It handles `--version`/`--help`, then renders `<App>` with `exitOnCtrlC: false`, because ctrl+c is handled in the app.
- **Config (`src/config/config.ts`)**: two layers, later wins: `~/.ekko/config.json` (zod-validated, written with mode 0600 because it can hold the API key), then env vars (`ANTHROPIC_API_KEY`, `EKKO_MODEL`). `FileConfig` is what's on disk; `resolveConfig()` produces the `Config` the app runs on. `EKKO_CONFIG_DIR` relocates the config, so use it when testing by hand to keep your real config untouched.
- **Setup (`src/ui/Setup.tsx`)** runs on first run, or when Anthropic has no key, and again via `/setup`. It renders *in place of the prompt* (pinned at the bottom, below the transcript), not as a separate screen.
- `createProvider(config)` in `src/provider/index.ts` is the only place that maps config to a concrete `Provider`.
- `src/app.tsx` holds all session state. The phases are `splash` → `main`, plus an optional setup overlay. It keeps two separate histories:
  - `items`: the **transcript the user sees**, including the welcome banner, help text, and errors.
  - `conversation` (a ref of `ChatTurn[]`): **what the model sees**, which is only real user/assistant turns.
  Keep them separate; ekko's own notices must never leak into the model's context.
- **Provider seam (`src/provider/types.ts`)**: every LLM vendor implements `Provider.stream(history, signal) → AsyncIterable<AgentEvent>`, converting its native stream into ekko's own `AgentEvent` union. The UI never imports a vendor SDK. `EchoProvider` is the stand-in until the Anthropic adapter lands.
- **Rendering**: ekko runs full-screen in the terminal's alternate screen (`alternateScreen: true` in `src/cli.tsx`), so there is no terminal scrollback. The root `<Box>` is sized to the window; `ScrollView` (`src/ui/ScrollView.tsx`) takes the leftover height and scrolls the transcript itself (PgUp/PgDn or the mouse wheel, follows the bottom until you scroll up; `followKey` snaps back on submit). The prompt and status bar are pinned below it. Don't use `<Static>` here: in the alternate screen its output would scroll off and be lost.
- **Mouse (`src/mouse.ts`)**: Ink has no mouse support, so ekko turns on SGR mouse reporting (mode 1002: presses, drags, wheel), wraps `stdin.read()` to strip mouse codes before Ink parses them, and emits `MouseEvent`s on the `mouse` emitter. Mouse mode is terminal-wide, so it is turned off in a `process.on("exit")` handler.
- **Selection (`src/selection.ts`, `src/clipboard.ts`)**: with mouse reporting on, the terminal can't select text, so ekko does: drag highlights, release copies (wl-copy / xclip / xsel / pbcopy, falling back to OSC 52), any key or wheel clears it. It works on *screen cells*, not React content: **ink is patched** (`patches/ink@8.0.0.patch`, applied by `bun install`) to add a `transformOutput(frame) → frame` render option. `selection.transformOutput` remembers each frame (to read the text back out) and inverts the selected cells; the App subscribes to the store so a selection change triggers a new frame.
- **Slash commands (`src/commands/index.ts`)** are pure functions that return a `CommandAction` (`print` | `clear` | `setup` | `exit`) and receive a read-only `CommandContext` (current config). The App applies the action. Add new commands to the `commands` array.
- Colors live only in `src/ui/theme.ts`.

## Conventions

- Imports use explicit `.ts`/`.tsx` extensions (`allowImportingTsExtensions` + `verbatimModuleSyntax`; use `import type` for types).
- UI tests use `ink-testing-library`. Pass `splashMs={0}` to skip the splash, `makeProvider={() => new EchoProvider(0)}` for an instant stream, and a `ConfigStore` on a temp dir.
- LLM default (when the provider is added): `claude-opus-5-5` via `@anthropic-ai/sdk`, streaming, with a manual tool loop behind the `Provider` interface.
