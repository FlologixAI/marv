// The system prompt: the instructions the model gets before the conversation.
// It's the only way to tell the model who it is and what situation it's in.
//
// It's built once per session and must stay byte-identical across requests:
// it's the start of every prompt, so any change would invalidate the
// provider's prompt cache for everything after it.
import { join } from "node:path";
import { memorySection, type Memories } from "./memory.ts";

export const INSTRUCTIONS_FILE = "AGENTS.md";
const MAX_INSTRUCTION_CHARS = 20_000;

interface PromptInput {
  /** Shown to the model, e.g. "~/Projects/ekko-agent". */
  cwd: string;
  /** Names of the tools on offer. */
  tools: string[];
  /** The project's AGENTS.md, if any. */
  instructions?: string;
  /** Available skills: only names and descriptions go in the prompt. */
  skills?: { name: string; description: string }[];
  /** What Marv remembers (personal and project), as of the start of the conversation. */
  memory?: Memories;
  /** Agent types the agent tool can start: names and descriptions only. */
  agents?: { name: string; description: string }[];
  date?: Date;
}

export function systemPrompt({ cwd, tools, instructions, skills = [], memory, agents = [], date = new Date() }: PromptInput): string {
  const base = `You are Marv, a coding agent running in the user's terminal.

Working directory: ${cwd}
Today's date: ${date.toISOString().slice(0, 10)}

You can explore the project with these tools: ${tools.join(", ")}. Look at the actual code before answering questions about it, and don't guess what a file contains. Start narrow: grep for a name or glob for a file pattern, then read the relevant part of a file rather than whole large files. Paths are relative to the project root.

You can change files with edit_file (replace exact text; copy it from read_file, whitespace included) and write_file (new files or full rewrites), and run shell commands with bash, e.g. the tests after a change. The user approves each change and command; if they decline, stop and ask how to proceed instead of trying another way. Commands run in a sandbox: only the project folder is writable, the home folder is hidden, and there's no network unless you set network: true. Make focused changes and check your work.

Your replies are rendered as Markdown in a terminal. Keep them concise and structured: short paragraphs, bullet or numbered lists for several items, \`backticks\` for file paths, identifiers and commands, and fenced code blocks with a language for code. Use a small table only when comparing things side by side. Point to code as path:line.`;

  const agentList = agents.length
    ? `\n\n# Agents\n\nThe agent tool hands a self-contained task to a subagent: a fresh agent that sees only the prompt you give it, works with its own tools, and returns a report. Use one for research across many files, implementing one well-specified task, or an independent review, and keep your own context for coordinating. Put everything it needs in the prompt. Several agent calls in a row run in parallel (up to 4 at once); give parallel agents that change files isolation: "worktree" so they don't collide, then review and merge their branches with git. A worktree starts from the last commit (HEAD): commit first if the agents need your uncommitted changes. Types:\n\n${agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`
    : "";
  const remembered = memory ? `\n\n${memorySection(memory)}` : "";
  return base + remembered + skillsSection(skills) + agentList + projectSection(instructions);
}

function skillsSection(skills: { name: string; description: string }[]): string {
  return skills.length
    ? `\n\n# Skills\n\nSkills are detailed instructions for particular kinds of tasks. When a request matches one of these, load it with the skill tool before you start, then follow it:\n\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
    : "";
}

const projectSection = (instructions?: string) => (instructions ? `\n\n# Project instructions (from ${INSTRUCTIONS_FILE})\n\n${instructions}` : "");

interface SubagentPromptInput {
  cwd: string;
  tools: string[];
  /** The agent type's own instructions; empty for general-purpose. */
  body: string;
  instructions?: string;
  skills?: { name: string; description: string }[];
  /** Set when it works in its own git worktree. */
  worktree?: { branch: string; base: string };
  date?: Date;
}

/**
 * A subagent's system prompt: its type's instructions, then what it needs to
 * know about its situation. No memory: that's the main agent's.
 */
export function subagentPrompt({ cwd, tools, body, instructions, skills = [], worktree, date = new Date() }: SubagentPromptInput): string {
  const role = body || "You are a general-purpose coding agent.";
  const hasBash = tools.includes("bash");
  const where = worktree
    ? `\n\nYou are working in your own git worktree, on branch ${worktree.branch} (started from ${worktree.base}). Other agents can't see your changes until your branch is merged. Files ignored by git, such as node_modules and build output, aren't here${hasBash ? ": install dependencies first if you need them (bash with network: true)" : ""}. Don't commit yourself (in the sandbox the repository is read-only; git status, diff and log work, but git commands that write the repository fail there: to undo a change, edit the file back; git checkout, restore, stash and add won't work here): when you finish, Marv commits everything you changed to your branch.`
    : "";
  const sandbox = hasBash ? " Commands run in a sandbox: only the working directory is writable, and there's no network unless you set network: true." : "";
  const editing = tools.includes("edit_file") ? " edit_file replaces exact text: copy it from read_file, whitespace included." : "";
  const base = `${role}

You are a subagent of Marv, a coding agent in the user's terminal. Another agent gave you the task in the first message. Your final message is your report back to it: start with a one-line summary, then say what you did, what you found, and anything left undone (in the format your instructions or the task ask for, if any). The agent that called you sees only that report, not your steps or tool output, so include everything it needs. Nobody can answer questions while you work: make reasonable assumptions and note them, or, if you're truly blocked, say what you need in your report.

Working directory: ${cwd}
Today's date: ${date.toISOString().slice(0, 10)}

Your tools: ${tools.join(", ")}. Look at the actual code before you change or judge it. Start narrow: grep for a name or glob for a file pattern, then read the relevant part of a file rather than whole large files. Paths are relative to the working directory.${editing}${sandbox}${where}`;
  return base + skillsSection(skills) + projectSection(instructions);
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
