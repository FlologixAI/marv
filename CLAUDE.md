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
- `src/app.tsx` holds all session state. The phases are `splash` → `main`. It keeps two separate histories:
  - `items`: the **transcript the user sees**, including the welcome banner, help text, and errors.
  - `conversation` (a ref of `ChatTurn[]`): **what the model sees**, which is only real user/assistant turns.
  Keep them separate; ekko's own notices must never leak into the model's context.
- **Provider seam (`src/provider/types.ts`)**: every LLM vendor implements `Provider.stream(history, signal) → AsyncIterable<AgentEvent>`, converting its native stream into ekko's own `AgentEvent` union. The UI never imports a vendor SDK. `EchoProvider` is the stand-in until the Anthropic adapter lands.
- **Rendering**: finished messages go through Ink `<Static>` (`src/ui/Transcript.tsx`), which prints each item once into scrollback. Only the streaming reply, prompt, and status bar re-render. `<Static>` remembers how many items it has already printed, so `/clear` wipes the screen *and* bumps a `key` to remount it.
- **Slash commands (`src/commands/index.ts`)** are pure functions that return a `CommandAction` (`print` | `clear` | `exit`). The App applies the action. Add new commands to the `commands` array.
- Colors live only in `src/ui/theme.ts`.

## Conventions

- Imports use explicit `.ts`/`.tsx` extensions (`allowImportingTsExtensions` + `verbatimModuleSyntax`; use `import type` for types).
- UI tests use `ink-testing-library`. Pass `splashMs={0}` to skip the splash, and `new EchoProvider(0)` for an instant stream.
- LLM default (when the provider is added): `claude-opus-5-5` via `@anthropic-ai/sdk`, streaming, with a manual tool loop behind the `Provider` interface.
