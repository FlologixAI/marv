// The tool registry: what the model is offered, and how its calls are run.
import { z } from "zod";
import type { ToolCall, ToolSpec } from "../provider/types.ts";
import { glob } from "./glob.ts";
import { grep } from "./grep.ts";
import { readFile } from "./read-file.ts";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "./types.ts";

export const tools: Tool[] = [readFile, glob, grep] as Tool[];

/**
 * What the model is told about each tool. Built once, so every request sends
 * byte-identical tool definitions (anything else would break the prompt cache).
 */
export const toolSpecs: ToolSpec[] = tools.map((tool) => {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, parameters };
});

/** Runs a call. Never throws: every failure becomes a result the model can read and recover from. */
export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult & { label: string }> {
  const tool = tools.find((t) => t.name === call.name);
  const fail = (output: string, label = call.name) => ({ output, summary: "error", isError: true, label });
  if (!tool) return fail(`Unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(", ")}.`);

  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments || "{}");
  } catch {
    return fail(`The arguments for ${call.name} are not valid JSON: ${call.arguments}`);
  }
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) return fail(`Invalid input for ${call.name}:\n${z.prettifyError(parsed.error)}`);

  const label = tool.label(parsed.data);
  try {
    return { ...(await tool.run(parsed.data, ctx)), label };
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message, label);
    return fail(`${call.name} failed: ${(err as Error).message}`, label);
  }
}
