// Prints a summary of Marv's trajectory logs: one row per model (or per Marv
// version), with how many turns ran, how the user rated them, what they cost
// in tokens and time, and how they ended. Use it to see whether a change (a
// new model, a prompt tweak, a new Marv version) made runs better.
//
//   bun run stats                         every log, grouped by model
//   bun run stats --by marv               grouped by Marv version instead
//   bun run stats ~/somewhere/a.jsonl     only these files or folders
//
// With no paths it reads ~/.marv/trajectories (or $MARV_CONFIG_DIR/trajectories).
// The counting itself lives in src/trajectory-stats.ts; this file only finds
// the logs, reads them, and prints the table.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "../src/config/config.ts";
import { formatStats, summarize, type GroupBy } from "../src/trajectory-stats.ts";

// --- Command-line arguments ---
// `--by <x>` picks the grouping. splice() takes the flag and its value out of
// `args`, so whatever is left is the list of paths to read.
const args = process.argv.slice(2);
const byAt = args.indexOf("--by");
const by = byAt >= 0 ? args.splice(byAt, 2)[1] : "model";
if (by !== "model" && by !== "marv") {
  console.error("--by takes model or marv");
  process.exit(1);
}

// --- Finding the log files ---
// Every .jsonl file at `path`: the file itself, or everything under a folder
// (trajectories are stored one folder per project, one file per session).
const files = (path: string): string[] =>
  statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : path.endsWith(".jsonl") ? [path] : [];

// --- Reading the records ---
// Each line of a log is one JSON record (a turn starting, a model request, a
// tool call, a rating…; see TrajectoryRecord in src/trajectory.ts). All files
// are read into one flat list: summarize() links records together by their
// session and turn ids, so which file a record came from doesn't matter.
const roots = args.length ? args : [join(defaultConfigDir(process.env), "trajectories")];
const records = roots
  .filter((root) => existsSync(root)) // a path that doesn't exist just has no logs
  .flatMap(files)
  .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean))
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      // Marv appends to a log while it runs, so a crash or a kill can leave
      // the last line half-written. Skip it rather than fail the whole report.
      return [];
    }
  });

// --- The report ---
// `by` was checked above, so the cast only tells TypeScript what we already know.
console.log(records.length ? formatStats(summarize(records, by as GroupBy)) : `No trajectories in ${roots.join(", ")} yet.`);
