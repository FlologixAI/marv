// Saved sessions: every conversation is kept so it can be picked up again.
//
//   ~/.marv/sessions/<project>/<id>.json
//
// A session holds both histories (kept separate, as in the App): the
// transcript the user saw and the conversation the model saw, plus which
// model it used and what it cost. Files are private (0600): they contain
// your code and prompts. Saved after every turn, atomically (write a temp
// file, then rename), so a crash never leaves a half-written session.
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectKey } from "./paths.ts";
import type { ChatTurn } from "./provider/types.ts";
import type { Message } from "./types.ts";
import { emptyTotals, type Totals } from "./usage.ts";

const VERSION = 1;
const TITLE_CHARS = 56;

export interface Session {
  version: number;
  id: string;
  root: string;
  createdAt: number;
  updatedAt: number;
  provider: string;
  model: string;
  /** What the model sees. */
  conversation: ChatTurn[];
  /** What the user saw. */
  transcript: Message[];
  totals: Totals;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messages: number;
  model: string;
}

export function newSession(root: string, { provider, model }: { provider: string; model: string }, now = Date.now()): Session {
  const id = `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  return { version: VERSION, id, root, createdAt: now, updatedAt: now, provider, model, conversation: [], transcript: [], totals: emptyTotals() };
}


function titleOf(session: Session): string {
  const first = session.transcript.find((m) => m.role === "user")?.text ?? "(empty)";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…` : line;
}

export class SessionStore {
  constructor(readonly dir: string) {}

  private folder(root: string) {
    return join(this.dir, projectKey(root));
  }

  /** Saves (or overwrites) a session. Sessions without a user message aren't saved. */
  async save(session: Session): Promise<void> {
    if (!session.transcript.some((m) => m.role === "user")) return;
    const folder = this.folder(session.root);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, `${session.id}.json`);
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify({ ...session, updatedAt: Date.now() }), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  }

  async load(root: string, id: string): Promise<Session | null> {
    const file = join(this.folder(root), `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      const session = (await Bun.file(file).json()) as Session;
      return session.version === VERSION ? session : null;
    } catch {
      return null;
    }
  }

  /** This project's sessions, newest first. Damaged files are skipped. */
  async list(root: string): Promise<SessionSummary[]> {
    const folder = this.folder(root);
    if (!existsSync(folder)) return [];
    const summaries: SessionSummary[] = [];
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const session = await this.load(root, name.slice(0, -".json".length));
      if (!session) continue;
      summaries.push({
        id: session.id,
        title: titleOf(session),
        updatedAt: session.updatedAt,
        messages: session.transcript.filter((m) => m.role === "user" || m.role === "assistant").length,
        model: session.model,
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async latest(root: string): Promise<Session | null> {
    const [newest] = await this.list(root);
    return newest ? this.load(root, newest.id) : null;
  }
}

export function timeAgo(then: number, now = Date.now()): string {
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
