// The agent loop: the heart of a coding agent.
//
//   send the conversation (+ tool definitions) → the model replies
//     ├─ it asked for tools?  run them, append the results, go again
//     └─ plain answer?        done
//
// The model decides which tools to use; this loop only runs what it asks for
// and reports back. It knows nothing about the UI or the vendor: it yields
// events, and `history` (the conversation the model sees) is appended to in
// place, never rewritten, so every request starts with the previous one and
// the provider's prompt cache keeps hitting.
//
// Tool calls run one at a time, except subagents: several `agent` calls in
// one reply run at the same time (at most MAX_PARALLEL), and their results are
// still appended in call order, so the history doesn't depend on which
// finished first.
import type { ChatTurn, Provider, ToolCall, ToolSpec, Usage } from "./provider/types.ts";
import type { ToolResult } from "./tools/types.ts";

export const DEFAULT_MAX_STEPS = 25;
export const MAX_PARALLEL = 4;

/** What the model is told about a call that never ran. */
export const NOT_RUN = {
  aborted: "Interrupted by the user before this tool ran.",
  declined: "Not run: the user declined an earlier action.",
};

type Result = ToolResult & { label: string };
type GroupEvent =
  | { type: "start"; index: number; call: ToolCall }
  | { type: "end"; index: number; call: ToolCall; result: Result }
  | { type: "skip"; index: number; result: Result };

export type LoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "usage"; usage: Usage }
  /** One step's reply text is complete. */
  | { type: "assistant"; text: string }
  | { type: "tool_start"; call: ToolCall; label: string }
  | { type: "tool_end"; call: ToolCall; result: ToolResult & { label: string } }
  | { type: "error"; message: string }
  /** It reached a multiple of maxSteps and asked (onLimit) whether to keep going. */
  | { type: "step_limit"; steps: number; continued: boolean }
  | { type: "done"; reason: "end" | "length" | "aborted" | "declined" | "max_steps" | "error" };

interface Options {
  provider: Provider;
  /** The conversation; appended to as the run goes. */
  history: ChatTurn[];
  system: string;
  tools: ToolSpec[];
  runTool: (call: ToolCall) => Promise<ToolResult & { label: string }>;
  signal: AbortSignal;
  maxSteps?: number;
  /**
   * Asked each time the run reaches another multiple of maxSteps, after that
   * step's tool results are in (so the history is valid whatever the answer):
   * true keeps going for another maxSteps. Without it, maxSteps is a hard stop.
   */
  onLimit?: (steps: number) => Promise<boolean>;
  /** Calls that may run at the same time as their neighbours (subagents). Default: none. */
  isParallel?: (call: ToolCall) => boolean;
  maxParallel?: number;
}

/**
 * A subagent's label ("explore · Find the config"): used here before the call
 * runs and by the agent tool's own `label` (src/tools/agent.ts) after, so the
 * transcript entry doesn't change when the call starts.
 */
export const agentLabel = (type: unknown, description: string) => `${typeof type === "string" ? type : "general-purpose"} · ${description}`;

/** The transcript label for a call before it runs ("src/app.ts"), falling back to the raw arguments. */
function labelOf(call: ToolCall): string {
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const agent = typeof args.description === "string" ? agentLabel(args.type, args.description) : undefined;
    return String(args.path ?? args.pattern ?? args.command ?? agent ?? call.arguments);
  } catch {
    return call.arguments;
  }
}

/**
 * Runs a group of calls at the same time (at most `limit` at once) and reports
 * each start and end as it happens. Calls still queued after an interrupt or a
 * "no" are answered without running.
 */
async function* runGroup(
  group: ToolCall[],
  runTool: Options["runTool"],
  limit: number,
  signal: AbortSignal,
): AsyncGenerator<GroupEvent> {
  // Calls finish whenever they like (in promise callbacks); their events wait
  // in `ready` until the generator's consumer gets to them, and `wake` resumes
  // the generator if it is waiting for one.
  const ready: GroupEvent[] = [];
  let wake: (() => void) | null = null;
  const emit = (event: GroupEvent) => {
    ready.push(event);
    wake?.();
    wake = null;
  };
  let next = 0;
  let active = 0;
  let settled = 0;
  let declined = false;
  // The abort first: Esc declines what's waiting *and* aborts, and that's an interrupt, not a "no".
  const notRun = (call: ToolCall): Result => ({ output: signal.aborted ? NOT_RUN.aborted : NOT_RUN.declined, summary: "not run", label: call.name });
  /** Reserves free slots for queued calls (or answers them, after an interrupt or a "no"). Runs nothing. */
  const startMore = () => {
    while (active < limit && next < group.length) {
      const index = next++;
      const call = group[index]!;
      if (signal.aborted || declined) {
        settled++;
        emit({ type: "skip", index, result: notRun(call) });
        continue;
      }
      active++;
      emit({ type: "start", index, call });
    }
  };
  const launch = (index: number, call: ToolCall) => {
    // Called right away, so whatever the tool does first (e.g. ask for
    // approval) happens before the next call is considered; a synchronous
    // throw becomes an error result instead of a call that never settles.
    let running: Promise<Result>;
    try {
      running = runTool(call);
    } catch (err) {
      running = Promise.reject(err);
    }
    void running
      .catch((err: unknown): Result => ({
        output: `${call.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        summary: "error",
        isError: true,
        label: call.name,
      }))
      .then((result) => {
        active--;
        settled++;
        declined ||= Boolean(result.declined);
        emit({ type: "end", index, call, result });
        startMore();
      });
  };
  startMore();
  while (settled < group.length || ready.length > 0) {
    if (ready.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    while (ready.length > 0) {
      const event = ready.shift()!;
      if (event.type === "start" && (signal.aborted || declined)) {
        // Reserved before the interrupt or the "no", but not shown yet: answer
        // it instead (no tool_start after either), and let the rest follow.
        active--;
        settled++;
        yield { type: "skip", index: event.index, result: notRun(event.call) };
        startMore();
        continue;
      }
      yield event;
      // A call runs only once its start has been delivered: a consumer that
      // stops at tool_start (it threw, or the user quit) never sees a tool
      // run that it can't show or stop.
      if (event.type === "start") launch(event.index, event.call);
    }
  }
}

export async function* runAgent({
  provider,
  history,
  system,
  tools,
  runTool,
  signal,
  maxSteps = DEFAULT_MAX_STEPS,
  onLimit,
  isParallel = () => false,
  maxParallel = MAX_PARALLEL,
}: Options): AsyncGenerator<LoopEvent> {
  for (let step = 0; ; step++) {
    // The step limit guards against a model that never finishes. With
    // onLimit, the user decides at each multiple whether it goes on.
    if (step > 0 && step % maxSteps === 0) {
      const continued = onLimit ? await onLimit(step) : false;
      if (onLimit) yield { type: "step_limit", steps: step, continued };
      if (signal.aborted) {
        yield { type: "done", reason: "aborted" };
        return;
      }
      if (!continued) {
        yield {
          type: "error",
          message: onLimit
            ? `Stopped at ${step} steps, as you asked. Say "continue" to pick up where it left off.`
            : `Stopped after ${step} steps without a final answer. Say "continue" to pick up where it left off.`,
        };
        yield { type: "done", reason: "max_steps" };
        return;
      }
    }
    let text = "";
    const calls: ToolCall[] = [];
    let error: string | null = null;
    let stopReason: string | undefined;

    for await (const event of provider.stream(history, { system, tools, signal })) {
      switch (event.type) {
        case "text_delta":
          text += event.text;
          yield event;
          break;
        case "thinking_delta":
        case "usage":
          yield event;
          break;
        case "tool_call":
          calls.push(event.call);
          break;
        case "done":
          stopReason = event.reason;
          break;
        case "error":
          error = event.message;
          break;
      }
    }

    if (text || calls.length > 0) {
      history.push(calls.length > 0 ? { role: "assistant", text, toolCalls: calls } : { role: "assistant", text });
    }
    if (text) yield { type: "assistant", text };

    if (error) {
      yield { type: "error", message: error };
      yield { type: "done", reason: "error" };
      return;
    }
    if (calls.length === 0) {
      yield { type: "done", reason: signal.aborted ? "aborted" : stopReason === "length" ? "length" : "end" };
      return;
    }

    // Every call must get a result, even after an interrupt or a "no": a
    // request with an unanswered tool call is rejected by the API.
    let declined = false;
    // How many calls have their result in the history: they're appended in call order, so the rest are a suffix.
    let answered = 0;
    const answer = (call: ToolCall, text: string) => {
      history.push({ role: "tool", callId: call.id, name: call.name, text });
      answered++;
    };
    try {
      for (let i = 0; i < calls.length; ) {
        // A run of consecutive parallel calls goes together; anything else, one at a time.
        let end = i + 1;
        if (isParallel(calls[i]!)) while (end < calls.length && isParallel(calls[end]!)) end++;
        const group = calls.slice(i, end);
        i = end;
        if (signal.aborted || declined) {
          // The abort first, as in runGroup: after Esc the model reads "Interrupted", not "the user declined".
          for (const call of group) answer(call, signal.aborted ? NOT_RUN.aborted : NOT_RUN.declined);
          continue;
        }
        const results: Result[] = [];
        for await (const event of runGroup(group, runTool, maxParallel, signal)) {
          if (event.type === "start") {
            yield { type: "tool_start", call: event.call, label: labelOf(event.call) };
          } else {
            results[event.index] = event.result;
            if (event.type === "end") yield { type: "tool_end", call: event.call, result: event.result };
          }
        }
        // In call order, whatever order they finished in (prompt cache).
        group.forEach((call, k) => answer(call, results[k]!.output));
        declined = results.some((r) => r.declined);
      }
    } finally {
      // The consumer stopped mid-tools (it threw while handling an event, or broke out of its loop): the calls
      // without a result would leave the history invalid, and the API would reject every request from now on.
      for (const call of calls.slice(answered)) history.push({ role: "tool", callId: call.id, name: call.name, text: NOT_RUN.aborted });
    }
    if (signal.aborted) {
      yield { type: "done", reason: "aborted" };
      return;
    }
    // The user said no: stop here and let them say what to do instead.
    if (declined) {
      yield { type: "done", reason: "declined" };
      return;
    }
  }
}
