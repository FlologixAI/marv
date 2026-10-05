import { z } from "zod";
import { sandboxAvailable } from "../sandbox.ts";
import { resolveType, runSubagent } from "../subagent.ts";
import { inspectRepo, NOT_A_REPO } from "../worktree.ts";
import { ToolError, type Tool } from "./types.ts";

const PREVIEW_CHARS = 400;

const input = z.object({
  type: z.string().optional().describe('The agent type, from the list in the system prompt. Default "general-purpose".'),
  description: z.string().min(1).describe('A short name for the task, 3-5 words, e.g. "Task 2: parser errors".'),
  prompt: z
    .string()
    .min(1)
    .describe("The complete task. The subagent sees nothing else: include the goal, the relevant files, constraints, and what to report back."),
  isolation: z
    .enum(["worktree"])
    .optional()
    .describe("Run it in its own git worktree on a new branch, so it can change files and build while other agents do too. You merge its branch afterwards."),
});

export const agent: Tool<typeof input> = {
  name: "agent",
  description:
    "Hand a self-contained task to a subagent: a separate agent with a fresh context and its own tools, which does the task and returns only its final report. " +
    "Several agent calls in a row run in parallel (up to 4 at once). The available types are listed in the system prompt.",
  input,
  kind: "execute",
  parallel: true,
  // Starting one in a worktree is the user's one approval for it; a
  // shared-folder subagent asks before each change it makes instead.
  needsApproval: ({ isolation }) => isolation === "worktree",
  label: ({ type, description }) => `${type ?? "general-purpose"} · ${description}`,
  scope: () => ({ key: "agent:worktree", description: "subagents in their own worktrees" }),

  async preview({ type, description, prompt }, ctx) {
    if (!ctx.agentHost) throw new ToolError("Subagents can't start subagents.");
    const found = resolveType(ctx.agentHost, type);
    const repo = inspectRepo(ctx.root);
    if (!repo) throw new ToolError(NOT_A_REPO);
    const auto = (ctx.sandbox ?? true) && sandboxAvailable();
    return {
      title: `Start ${found.name} in its own worktree: ${description}`,
      text: prompt.length > PREVIEW_CHARS ? `${prompt.slice(0, PREVIEW_CHARS)}…` : prompt,
      note: `new branch from ${repo.base} · ${auto ? "edits and sandboxed commands run without asking inside its worktree" : "asks before each change (no sandbox)"}`,
      warning: repo.dirty
        ? `${repo.dirty} uncommitted change${repo.dirty === 1 ? "" : "s"} in the project won't be in the worktree (it starts from ${repo.base})`
        : undefined,
    };
  },

  // An arrow, not `run: runSubagent`: src/subagent.ts and the registry import
  // each other, and this defers the lookup until a call.
  run: (args, ctx) => runSubagent(args, ctx),
};
