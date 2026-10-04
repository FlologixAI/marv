import type { z } from "zod";

export interface ToolContext {
  /** Absolute path of the project root; tools may not reach outside it. */
  root: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** What the model sees. */
  output: string;
  /** A few words for the transcript, e.g. "42 lines". */
  summary: string;
  isError?: boolean;
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
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/** An expected failure (bad path, missing file); its message goes to the model as-is. */
export class ToolError extends Error {}
