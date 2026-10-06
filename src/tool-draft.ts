// A tool call the model is still writing: its arguments arrive as fragments of JSON, and a write_file's content
// can take minutes (18k tokens for one page, in a trajectory). These read what's arrived so far, unfinished JSON
// and all, so the screen can say what's being written instead of looking hung.

/** The value of `key` in unfinished JSON, decoded as far as it has arrived; null if it hasn't started. */
function partialString(json: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
  if (!match) return null;
  // An escape cut in half: a lone backslash at the end, or \u with fewer than 4 hex digits.
  const raw = match[1]!.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return null;
  }
}

/** "Writing src/app.js…": what the call is about to do, for the waiting line. */
export function draftLabel(name: string, args: string): string {
  const path = partialString(args, "path")?.split("\n")[0];
  switch (name) {
    case "write_file":
      return `Writing ${path || "a file"}…`;
    case "edit_file":
      return `Editing ${path || "a file"}…`;
    case "bash":
      return "Writing a command…";
    default:
      return `Preparing ${name || "a tool call"}…`;
  }
}

/** The code written so far (a file's content, an edit's new text, a command), or "" for anything else. */
export function draftPreview(name: string, args: string): string {
  const key = { write_file: "content", edit_file: "new_string", bash: "command" }[name];
  return key ? (partialString(args, key) ?? "") : "";
}
