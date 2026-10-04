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
bun test -t "streams"       # tests whose name matches
bun run typecheck           # tsc --noEmit
bun link                    # (once) puts `ekko` on PATH, pointing at src/cli.tsx — no build step
```

## Architecture

- `src/cli.tsx` is the `bin` entry (Bun shebang). It handles `--version`/`--help`, takes the project root from the current directory, reads the project's `AGENTS.md` once (`loadInstructions` in `src/prompt.ts`, capped at 20k chars), then renders `<App>`.
- **Config (`src/config/config.ts`)**: two layers, later wins: `~/.ekko/config.json` (zod-validated, written with mode 0600 because it can hold the API key), then env vars (`OPENROUTER_API_KEY`, `EKKO_MODEL`, `OLLAMA_HOST`). `PRESETS` describes each provider (label, base URL, which env var holds its key, default model). `FileConfig` is what's on disk; `resolveConfig()` produces the `Config` the app runs on. `EKKO_CONFIG_DIR` relocates the config, so use it when testing by hand to keep your real config untouched.
- **Setup (`src/ui/Setup.tsx`)** runs on first run, or when OpenRouter has no key, and again via `/setup` (and `/model`, starting at the model step). It renders *in place of the prompt* (pinned at the bottom, below the transcript), not as a separate screen.
- `createProvider(config)` in `src/provider/index.ts` is the only place that maps config to a concrete `Provider`. OpenRouter uses `OpenAICompatProvider` (`src/provider/openai-compat.ts`: plain `fetch` to `POST {baseUrl}/chat/completions`, SSE parsed by `src/provider/sse.ts`; tool calls arrive in fragments keyed by `index` and are assembled before being emitted; `stream_options.include_usage` gets token counts incl. cached tokens). Ollama uses `OllamaProvider` (`src/provider/ollama.ts`: native `POST /api/chat`, NDJSON), because only the native API can set the context window (`num_ctx` = config `contextLength`, default 32768; Ollama's own default of 4096 is too small for an agent). `think` follows `/think` (off by default: local thinking models can otherwise reason for minutes).
- `src/app.tsx` holds all session state. The phases are `splash` → `main`, plus an optional setup overlay. It keeps two separate histories:
  - `items`: the **transcript the user sees**, including the welcome banner, help text, and errors.
  - `conversation` (a ref of `ChatTurn[]`): **what the model sees**: user and assistant turns, the assistant's tool calls, and tool results.
  Keep them separate; ekko's own notices must never leak into the model's context.
- **Agent loop (`src/agent.ts`)**: `runAgent()` sends the conversation plus tool definitions, runs any tools the model asks for (via an injected `runTool`), appends the results, and repeats until a plain answer, an error, ctrl+c, or 25 steps. It yields `LoopEvent`s and knows nothing about the UI or vendors; `App.send()` turns the events into transcript entries (tool calls are `role: "tool"` messages updated in place: running → summary or error). Every tool call gets a result, even after ctrl+c, or the next request would be rejected.
- **Tools (`src/tools/`)**: each is a name, a description the model reads, a zod `input` schema (sent as JSON schema; also validates what comes back), a `label` for the transcript, and `run()` → `{ output, summary }`. Register new ones in `tools` in `src/tools/index.ts`. `runTool()` never throws: bad JSON, invalid input, and `ToolError`s become error results the model can recover from. All paths go through `resolveInProject()` (`src/tools/files.ts`), which rejects anything outside the project root, including via symlinks. Files are listed with `git ls-files` (so `.gitignore` applies), falling back to a walk that skips `node_modules`, `.git`, `dist`, etc.
- **Prompt cache (don't break it)**: providers reuse work for an identical prompt *prefix* (measured on Ollama: a follow-up turn's prompt in 76 ms instead of 1.2 s; one changed letter in the system prompt and it's back to 1.2 s). So: the system prompt is built once per session (`useMemo` in `App`), `toolSpecs` is a constant, `conversation` is only appended to (never edited or trimmed; `/clear` resets it), and adapters serialize deterministically. `tests/agent.test.ts` checks that every request extends the previous one exactly. The status bar shows the last request's size (`12.3k/32.8k ctx` when the window is known) and the cache hit rate when the provider reports it (OpenRouter); ekko warns once when Ollama's window is 85% full.
- **Provider seam (`src/provider/types.ts`)**: every provider implements `Provider.stream(history, { system, tools, signal }) → AsyncIterable<AgentEvent>` (`text_delta`, `thinking_delta`, `tool_call`, `usage`, `done`, `error`), converting its native stream into ekko's own events. The UI never sees a vendor format. Errors become `error` events with an actionable message (bad key → /setup, unknown model → /model, unreachable → is it running?). The system prompt lives in `src/prompt.ts`. Model lists for the picker come from `src/provider/models.ts` (OpenRouter `/models`, filtered to tool-capable; Ollama `/api/tags` + `/api/show`).
- **Rendering**: ekko runs full-screen in the terminal's alternate screen, so there is no terminal scrollback. Ink's options live in `src/render-options.ts`; keep `incrementalRendering: true`, because without it every update (each martian frame, each keystroke) erases and redraws the whole screen, which flickers in terminals like GNOME Console. `tests/render-options.test.tsx` guards this. The root `<Box>` is sized to the window; `ScrollView` (`src/ui/ScrollView.tsx`) takes the leftover height and scrolls the transcript itself (PgUp/PgDn or the mouse wheel, follows the bottom until you scroll up; `followKey` snaps back on submit). The prompt and status bar are pinned below it. Don't use `<Static>` here: in the alternate screen its output would scroll off and be lost.
- **Mouse (`src/mouse.ts`)**: Ink has no mouse support, so ekko turns on SGR mouse reporting (mode 1002: presses, drags, wheel), wraps `stdin.read()` to strip mouse codes before Ink parses them, and emits `MouseEvent`s on the `mouse` emitter. Mouse mode is terminal-wide, so it is turned off in a `process.on("exit")` handler.
- **Selection (`src/selection.ts`, `src/clipboard.ts`)**: with mouse reporting on, the terminal can't select text, so ekko does: drag highlights, release copies (wl-copy / xclip / xsel / pbcopy, falling back to OSC 52), any key or wheel clears it. It works on *screen cells*, not React content: **ink is patched** (`patches/ink@8.0.0.patch`, applied by `bun install`) to add a `transformOutput(frame) → frame` render option. `selection.transformOutput` remembers each frame (to read the text back out) and inverts the selected cells; the App subscribes to the store so a selection change triggers a new frame.
- **Slash commands (`src/commands/index.ts`)** are pure functions that return a `CommandAction` (`print` | `clear` | `setup` | `model` | `thinking` | `exit`) and receive a read-only `CommandContext` (current config). The App applies the action. Add new commands to the `commands` array; they automatically show up in the `/` menu (`PromptInput`: ↑/↓ select, Enter runs the highlighted one, Tab completes so you can add arguments).
- Colors live only in `src/ui/theme.ts`. Message markers (`●`, `>`) sit in a fixed 2-column `Gutter` box: a Text with a trailing space (`"● "`) is laid out 1 column narrower than it's drawn, so the text beside it overflows and loses a character per wrap (`tests/messageview.test.tsx`).

## Conventions

- Imports use explicit `.ts`/`.tsx` extensions (`allowImportingTsExtensions` + `verbatimModuleSyntax`; use `import type` for types).
- UI tests use `ink-testing-library`. Pass `splashMs={0}` to skip the splash, `makeProvider={() => new FakeProvider()}` (`tests/fake-provider.ts`) for an instant, offline stream (or a `ScriptedProvider` to script tool calls step by step), a `root` temp dir for the tools, and a `ConfigStore` on a temp dir.
- Providers: OpenRouter (default model `anthropic/claude-sonnet-5.5`) and Ollama (local, no key). A saved provider ekko no longer knows (e.g. the removed `echo`) is dropped on load, which reopens setup. Tests never hit the network: the adapters are tested against a local `Bun.serve`, and `App` takes `loadModels`/`makeProvider` props.
