// The tool registry: what the model is offered, and how its calls are run.
import { isAbsolute, sep } from "node:path";
import { z } from "zod";
import type { ToolCall, ToolSpec } from "../provider/types.ts";
import { bash } from "./bash.ts";
import { editFile } from "./edit-file.ts";
import { projectPath } from "./files.ts";
import { glob } from "./glob.ts";
import { grep } from "./grep.ts";
import { memory } from "./memory.ts";
import { readFile } from "./read-file.ts";
import { skill } from "./skill.ts";
import { writeFile } from "./write-file.ts";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "./types.ts";

export const tools: Tool[] = [readFile, glob, grep, skill, editFile, writeFile, bash, memory] as Tool[];

/**
 * What the model is told about each tool. Built once, so every request sends
 * byte-identical tool definitions (anything else would break the prompt cache).
 */
export const toolSpecs: ToolSpec[] = tools.map((tool) => {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return { name: tool.name, description: tool.description, parameters };
});

/** The specs for a session: the skill tool only when there are skills to load. Same objects every time (cache). */
export function toolSpecsFor({ hasSkills }: { hasSkills: boolean }): ToolSpec[] {
  return hasSkills ? toolSpecs : toolSpecs.filter((spec) => spec.name !== "skill");
}

/**
 * Runs a call. Never throws: every failure becomes a result the model can read
 * and recover from. `available` is what this agent was offered (a subagent
 * gets fewer tools); anything else is unknown, even if the model names it.
 */
export async function runTool(call: ToolCall, ctx: ToolContext, available: Tool[] = tools): Promise<ToolResult & { label: string }> {
  const tool = available.find((t) => t.name === call.name);
  const fail = (output: string, label = call.name) => ({ output, summary: "error", isError: true, label });
  if (!tool) return fail(`Unknown tool "${call.name}". Available tools: ${available.map((t) => t.name).join(", ")}.`);

  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments || "{}");
  } catch {
    return fail(`The arguments for ${call.name} are not valid JSON: ${call.arguments}`);
  }
  const parsed = tool.input.safeParse(raw);
  if (!parsed.success) return fail(`Invalid input for ${call.name}:\n${z.prettifyError(parsed.error)}`);

  const label = shortLabel(tool.label(parsed.data), ctx.root);
  try {
    // Tools that change something need the user's go-ahead. The preview runs
    // first, so a call that can't succeed fails here instead of being approved.
    const gated = tool.needsApproval ? tool.needsApproval(parsed.data) : Boolean(tool.kind && tool.kind !== "read");
    if (gated) {
      if (!ctx.approve) return fail(`${call.name} needs the user's approval, and there's no one to ask.`, label);
      const preview = await tool.preview!(parsed.data, ctx);
      const scope = tool.scope?.(parsed.data) ?? { key: call.name, description: call.name };
      const network = tool.usesNetwork?.(parsed.data) ? { network: true } : {};
      const decision = await ctx.approve({ tool: call.name, label, preview, scope, ...network });
      if (decision === "no") {
        return {
          output: "The user declined this. Don't retry it: stop and wait for them to say how to proceed.",
          summary: "declined",
          declined: true,
          label,
        };
      }
    }
    return { ...(await tool.run(parsed.data, { ...ctx, callId: call.id })), label };
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message, label);
    return fail(`${call.name} failed: ${(err as Error).message}`, label);
  }
}

/** Models sometimes pass absolute paths; the transcript shows them relative to the project. */
function shortLabel(label: string, root: string): string {
  return isAbsolute(label) && label.startsWith(root + sep) ? projectPath(root, label) : label;
}
