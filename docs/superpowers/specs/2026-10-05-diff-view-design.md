# Diffs in the transcript

## Goal

Every file change shows what changed, under its transcript entry, like an approval prompt does before it:

```
● edit_file public/html/boids.html
  ⎿ +14 −3
     12   const maxSpeed = 3;
     13 - const sep = 0.7;
     13 + const sep = 0.8;
     14 + const align = 0.5;
     … 10 more lines (ctrl+o)
```

Today the transcript shows only the summary (`+14 −3`), so a change that ran without asking (yolo) is never seen.

## Decisions

- **Every edit**, auto-run or approved, `edit_file` and `write_file`. A **new file** shows its first lines as
  additions.
- **Collapsed to 15 lines**, with `… N more lines (ctrl+o)`. ctrl+o (today: subagents' steps) becomes "show
  details": steps and full diffs.
- **Line numbers**: new line numbers for added and unchanged lines, old ones for removed lines. The approval
  prompt shows them too: one `DiffView` draws diffs in both places.
- **Stored up to 400 lines** per change (the rest counted as "N more lines"), in saved sessions too, so
  `marv -c` shows them.
- **Subagents' edits** show their diffs in the subagent's own view.

## How

- `DiffLine` gains `oldLine?`/`newLine?`; `diffText` fills them from the hunks. New helpers in
  `src/tools/diff.ts`: `addedLines(content)` (a new file as numbered additions) and `shownDiff(lines)` (capped
  at 400: `{ lines, more }`).
- `ToolResult` gains `diff?: DiffShown` (`{ lines, more }`): **for display only**. `runAgent` puts only
  `output` in the conversation and trajectories record only named fields, so neither the model nor the logs
  see it. `edit_file` and `write_file` set it in `run()` from the diff they already compute.
- The session's `tool_end` event carries the result unchanged; `App.send()` and the subagent log
  (`applyEvent`) copy it to `ToolStatus.diff`.
- `src/ui/DiffView.tsx` draws lines with numbers, colors from the theme, `printable()` on file text, an
  optional limit and "… N more lines (hint)". `Approval` and `MessageView` use it.
- `Transcript` passes ctrl+o's flag to entries with steps or a diff (only those re-render on ctrl+o);
  `AgentView` gets the flag too.

## Testing

- `diffText` line numbers across hunks; `addedLines`; `shownDiff`'s cap.
- `edit_file`/`write_file` results carry the diff (overwrite, new file, the cap); the conversation and the
  trajectory don't.
- `MessageView`: collapsed (15 lines + hint), expanded (all, no hint), line numbers, new file.
- App: an edit that runs unasked shows its diff in the transcript; ctrl+o expands it.
- `tests/render-performance.test.tsx` stays green.
