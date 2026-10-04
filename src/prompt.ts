// The system prompt: the instructions the model gets before the conversation.
// It's the only way to tell the model who it is and what situation it's in.
//
// It's built once per session and must stay byte-identical across requests:
// it's the start of every prompt, so any change would invalidate the
// provider's prompt cache for everything after it.
import { join } from "node:path";

export const INSTRUCTIONS_FILE = "AGENTS.md";
const MAX_INSTRUCTION_CHARS = 20_000;

interface PromptInput {
  /** Shown to the model, e.g. "~/Projects/ekko-agent". */
  cwd: string;
  /** Names of the tools on offer. */
  tools: string[];
  /** The project's AGENTS.md, if any. */
  instructions?: string;
  date?: Date;
}

export function systemPrompt({ cwd, tools, instructions, date = new Date() }: PromptInput): string {
  const base = `You are ekko, a coding agent running in the user's terminal.

Working directory: ${cwd}
Today's date: ${date.toISOString().slice(0, 10)}

You can explore the project with these tools: ${tools.join(", ")}. Look at the actual code before answering questions about it, and don't guess what a file contains. Start narrow: grep for a name or glob for a file pattern, then read the relevant part of a file rather than whole large files. Paths are relative to the project root.

You can't edit files or run commands yet. If a task needs that, say exactly what to change and where.

Your replies are rendered as Markdown in a terminal. Keep them concise and structured: short paragraphs, bullet or numbered lists for several items, \`backticks\` for file paths, identifiers and commands, and fenced code blocks with a language for code. Use a small table only when comparing things side by side. Point to code as path:line.`;

  return instructions ? `${base}\n\n# Project instructions (from ${INSTRUCTIONS_FILE})\n\n${instructions}` : base;
}

/**
 * The project's AGENTS.md (the convention many coding agents share for
 * project-specific instructions), read once at startup. Capped so a huge
 * file can't eat the context window.
 */
export async function loadInstructions(root: string): Promise<string | undefined> {
  const file = Bun.file(join(root, INSTRUCTIONS_FILE));
  if (!(await file.exists())) return undefined;
  const text = (await file.text()).trim();
  if (!text) return undefined;
  if (text.length <= MAX_INSTRUCTION_CHARS) return text;
  return `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n\n(${INSTRUCTIONS_FILE} was cut off here: it's longer than ${MAX_INSTRUCTION_CHARS} characters.)`;
}
