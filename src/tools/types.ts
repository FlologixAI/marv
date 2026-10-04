import type { z } from "zod";
import type { MemoryPaths } from "../memory.ts";
import type { Skill } from "../skills.ts";

/** One line of a diff, for showing a change before it's approved. */
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  text: string;
}

/** What the approval prompt shows before a tool changes something. */
export interface Preview {
  /** e.g. "Edit src/app.ts", "Run a command". */
  title: string;
  /** The change, as a diff. */
  diff?: DiffLine[];
  /** A shell command, shown as "$ command". */
  command?: string;
  /** Plain text, e.g. a memory to save. */
  text?: string;
  /** A small detail line, e.g. "sandboxed · no network". */
  note?: string;
  /** Shown in the warning color, e.g. "runs WITHOUT a sandbox". */
  warning?: string;
}

/** "Don't ask again this session" applies to everything with the same key. */
export interface Scope {
  key: string;
  /** For the prompt: "Yes, don't ask again for <description>". */
  description: string;
}

export interface ApprovalRequest {
  tool: string;
  label: string;
  preview: Preview;
  scope: Scope;
}

/** yes: run it. always: run it, and everything in its scope this session. no: don't. */
export type Decision = "yes" | "always" | "no";

export interface ToolContext {
  /** Absolute path of the project root; tools may not reach outside it. */
  root: string;
  signal?: AbortSignal;
  /** Asks the user before a tool that changes something runs. Without it, such tools are refused. */
  approve?: (request: ApprovalRequest) => Promise<Decision>;
  /** Run bash in the bubblewrap sandbox (default true). */
  sandbox?: boolean;
  /** Skills the `skill` tool can load. */
  skills?: Skill[];
  /** Where the memory tool reads and writes. */
  memory?: MemoryPaths;
}

export interface ToolResult {
  /** What the model sees. */
  output: string;
  /** A few words for the transcript, e.g. "42 lines". */
  summary: string;
  isError?: boolean;
  /** The user said no: the agent stops so they can say what to do instead. */
  declined?: boolean;
}

/**
 * A tool is a name, a description the model reads to decide when to use it,
 * a zod schema for its input (sent to the model as JSON schema, and used to
 * validate what the model sends back), and the code that runs it.
 */
export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Short label for the transcript, e.g. the file path. */
  label(input: z.infer<S>): string;
  /** "read" (the default) runs freely; "write" and "execute" need the user's approval first. */
  kind?: "read" | "write" | "execute";
  /** What the approval prompt shows. Throw a ToolError here for a call that can't succeed, so the user isn't asked to approve it. */
  preview?(input: z.infer<S>, ctx: ToolContext): Promise<Preview>;
  /** What "don't ask again" covers. */
  scope?(input: z.infer<S>): Scope;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** An expected failure (bad path, missing file); its message goes to the model as-is. */
export class ToolError extends Error {}
