// What an eval run records, and the table that compares them. Pure: evals/run.ts does the running and the
// reading of result files; this only counts.

/** One model on one task, once: a line of an evals/results/*.jsonl file. */
export interface RunResult {
  /** What's being compared, e.g. "baseline" or "fuzzy-edits" (--label). */
  label: string;
  model: string;
  task: string;
  /** Which repetition (0-based). */
  rep: number;
  /** The task's hidden check passed. */
  pass: boolean;
  /** How the agent's run ended: the loop's done reason, "timeout", or "error" when it never got going. */
  reason: string;
  error?: string;
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  /** USD, as OpenRouter reported it. */
  cost: number;
  ms: number;
  /** Calls and failed calls, per tool. */
  tools: Record<string, { calls: number; errors: number }>;
  /** Replies with no text and no tool calls (each retried, nudged or ending the run). */
  emptyReplies?: number;
  /** File changes after which Marv said the file no longer parses. */
  syntaxNotes?: number;
  /** The model ran a typecheck itself (a guess from the command's text: a bash command naming tsc, tsgo or `run typecheck`). */
  ranTypecheck?: boolean;
  /** Steps after which Marv told the model about new type errors (post-edit diagnostics). */
  checkNotes?: number;
  /** Whether Marv's typecheck after file changes was on for this run. */
  diagnostics: boolean;
  /** The start of each failed edit_file result: what went wrong. */
  editErrors: string[];
  /** The tail of the check's output, for a failure. */
  checkOutput?: string;
  /** Marv's git commit, and whether its working tree had changes. */
  marv?: string;
}

export interface SummaryRow {
  label: string;
  model: string;
  runs: number;
  passed: number;
  editCalls: number;
  editErrors: number;
  toolCalls: number;
  requests: number;
  cost: number;
  medianMs: number;
}

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const groupKey = (r: RunResult) => `${r.label}\u0000${r.model}`;

/** One row per label and model, in the order they first appear. */
export function summarizeRuns(results: RunResult[]): SummaryRow[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) groups.set(groupKey(r), [...(groups.get(groupKey(r)) ?? []), r]);
  return [...groups.values()].map((runs) => {
    const tools = runs.flatMap((r) => Object.entries(r.tools));
    const edits = tools.filter(([name]) => name === "edit_file").map(([, t]) => t);
    return {
      label: runs[0]!.label,
      model: runs[0]!.model,
      runs: runs.length,
      passed: runs.filter((r) => r.pass).length,
      editCalls: edits.reduce((n, t) => n + t.calls, 0),
      editErrors: edits.reduce((n, t) => n + t.errors, 0),
      toolCalls: tools.reduce((n, [, t]) => n + t.calls, 0),
      requests: runs.reduce((n, r) => n + r.requests, 0),
      cost: runs.reduce((n, r) => n + r.cost, 0),
      medianMs: median(runs.map((r) => r.ms)),
    };
  });
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "-");

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd()).join("\n");
}

/** The comparison table, then which tasks each group passed (passed/runs). */
export function formatSummary(results: RunResult[]): string {
  if (results.length === 0) return "No runs.";
  const rows = summarizeRuns(results);
  const head = ["label", "model", "runs", "pass", "edits", "edit fail", "steps/run", "tools/run", "$/run", "$ total", "median"];
  const overview = table([
    head,
    ...rows.map((r) => [
      r.label,
      r.model,
      String(r.runs),
      pct(r.passed, r.runs),
      String(r.editCalls),
      pct(r.editErrors, r.editCalls),
      (r.requests / r.runs).toFixed(1),
      (r.toolCalls / r.runs).toFixed(1),
      (r.cost / r.runs).toFixed(4),
      r.cost.toFixed(3),
      `${(r.medianMs / 1000).toFixed(0)}s`,
    ]),
  ]);
  const tasks = [...new Set(results.map((r) => r.task))].sort();
  const grid = table([
    ["task", ...rows.map((r) => `${r.label}/${r.model}`)],
    ...tasks.map((task) => [
      task,
      ...rows.map((row) => {
        const runs = results.filter((r) => groupKey(r) === `${row.label}\u0000${row.model}` && r.task === task);
        return runs.length ? `${runs.filter((r) => r.pass).length}/${runs.length}` : "-";
      }),
    ]),
  ]);
  return `${overview}\n\n${grid}`;
}
