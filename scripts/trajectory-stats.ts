// bun run stats [--by model|marv] [folders or .jsonl files…]
// Sums up trajectory logs (default: all of ~/.marv/trajectories, or $MARV_CONFIG_DIR/trajectories).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "../src/config/config.ts";
import { formatStats, summarize, type GroupBy } from "../src/trajectory-stats.ts";

const args = process.argv.slice(2);
const byAt = args.indexOf("--by");
const by = byAt >= 0 ? args.splice(byAt, 2)[1] : "model";
if (by !== "model" && by !== "marv") {
  console.error("--by takes model or marv");
  process.exit(1);
}

const files = (path: string): string[] =>
  statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : path.endsWith(".jsonl") ? [path] : [];

const roots = args.length ? args : [join(defaultConfigDir(process.env), "trajectories")];
const records = roots
  .filter((root) => existsSync(root))
  .flatMap(files)
  .flatMap((file) => readFileSync(file, "utf8").split("\n").filter(Boolean))
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return []; // a line cut short by a crash
    }
  });

console.log(records.length ? formatStats(summarize(records, by as GroupBy)) : `No trajectories in ${roots.join(", ")} yet.`);
