// Memory: short notes Marv keeps across sessions, in two scopes.
//
//   ~/.marv/memory/personal.md                  everywhere (your preferences)
//   ~/.marv/memory/projects/<project>.md        one project (facts not obvious from its code)
//
// Plain Markdown, one "- " bullet per memory, so you can read and edit them.
// Loaded into the system prompt when a conversation starts. The model changes
// them through the memory tool, with your approval each time: memory persists,
// so an instruction planted by a malicious file and saved there would come
// back in every future session (a persistent prompt injection).
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { legacyProjectKey, projectKey } from "./paths.ts";
import { writePrivate } from "./private-file.ts";

export type MemoryScope = "personal" | "project";

export interface MemoryPaths {
  personal: string;
  project: string;
  /** Where the project file was before project keys had a hash: moved to `project` on load. */
  legacyProject?: string;
}

export interface Memories {
  personal: string[];
  project: string[];
}

const MAX_ENTRY_CHARS = 500;
const MAX_ENTRIES = 100;

const HEADERS: Record<MemoryScope, string> = {
  personal: "# Marv's memory: personal (applies to all projects)",
  project: "# Marv's memory: this project",
};

export function memoryPaths(configDir: string, root: string): MemoryPaths {
  return {
    personal: join(configDir, "memory", "personal.md"),
    project: join(configDir, "memory", "projects", `${projectKey(root)}.md`),
    legacyProject: join(configDir, "memory", "projects", `${legacyProjectKey(root)}.md`),
  };
}

/** Which scope a memory file belongs to (project files live under memory/projects/). */
const scopeOf = (path: string): MemoryScope => (path.includes(join("memory", "projects")) ? "project" : "personal");

/** A top-level bullet ("- ", "* " or "+ "): one memory. Anything else (headings, prose, nested bullets) is yours. */
const BULLET = /^[-*+] (.*)$/;

const readLines = async (path: string) => (existsSync(path) ? (await Bun.file(path).text()).split("\n") : []);

/** The memories in a file: its top-level bullets. */
async function readEntries(path: string): Promise<string[]> {
  return (await readLines(path)).flatMap((line) => {
    const entry = BULLET.exec(line.trimEnd())?.[1]?.trim();
    return entry ? [entry] : [];
  });
}

/**
 * Changes go line by line: adding appends one bullet, removing deletes the one line that holds it. Every other
 * line stays as written, since the file is yours to edit too (rewriting it from its bullets wiped headings,
 * notes and nested bullets).
 */
async function appendEntry(path: string, entry: string) {
  const text = existsSync(path) ? await Bun.file(path).text() : `${HEADERS[scopeOf(path)]}\n\n`;
  await writePrivate(path, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}- ${entry}\n`);
}

async function deleteEntry(path: string, entry: string) {
  const lines = await readLines(path);
  const at = lines.findIndex((line) => BULLET.exec(line.trimEnd())?.[1]?.trim() === entry);
  if (at >= 0) lines.splice(at, 1);
  await writePrivate(path, lines.join("\n"));
}

export async function loadMemory(paths: MemoryPaths): Promise<Memories> {
  // The old key wasn't unique, so the first project to load it claims it: before this fix, colliding projects
  // already shared that one file.
  if (paths.legacyProject && !existsSync(paths.project) && existsSync(paths.legacyProject)) await rename(paths.legacyProject, paths.project);
  return { personal: await readEntries(paths.personal), project: await readEntries(paths.project) };
}

/** One line, at most MAX_ENTRY_CHARS. */
const normalize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_CHARS);

export async function addMemory(path: string, text: string): Promise<{ added: boolean; error?: string }> {
  const entry = normalize(text);
  if (!entry) return { added: false, error: "A memory can't be empty." };
  const entries = await readEntries(path);
  if (entries.some((e) => e.toLowerCase() === entry.toLowerCase())) return { added: false };
  if (entries.length >= MAX_ENTRIES) return { added: false, error: `Memory is full (${MAX_ENTRIES} entries). Remove something first.` };
  await appendEntry(path, entry);
  return { added: true };
}

/** The memories that contain `match` (case-insensitive). */
export async function findMemory(path: string, match: string): Promise<string[]> {
  const needle = normalize(match).toLowerCase();
  return (await readEntries(path)).filter((e) => e.toLowerCase().includes(needle));
}

/** Removes the one memory containing `match`; refuses when none or several match. */
export async function removeMemory(path: string, match: string): Promise<{ removed: string } | { error: string }> {
  const scope = scopeOf(path);
  const found = await findMemory(path, match);
  if (found.length === 0) return { error: `No ${scope} memory matches "${match}".` };
  if (found.length > 1) return { error: `${found.length} memories match "${match}"; use more of the text: ${found.map((f) => `"${f}"`).join(", ")}.` };
  await deleteEntry(path, found[0]!);
  return { removed: found[0]! };
}

/** The system prompt's Memory section. */
export function memorySection({ personal, project }: Memories): string {
  const list = (entries: string[]) => (entries.length ? entries.map((e) => `- ${e}`).join("\n") : "(nothing yet)");
  return `# Memory

You keep a memory across sessions, in two parts: personal (applies everywhere: the user's preferences and how they like you to work) and project (facts about this project that aren't obvious from its code or instructions). When you learn something worth knowing next time, especially a preference or a correction from the user, save it with the memory tool; the user approves each change. Keep each memory to one short sentence. Don't save temporary details of the current task, things already written in the code, or secrets. If a memory turns out to be wrong, remove it.

Personal (all projects):
${list(personal)}

This project:
${list(project)}`;
}
