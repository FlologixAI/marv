// Writing a private file (sessions, memory, MCP trust): readable only by you
// (0600, in a 0700 folder), and never left half-written.
//
// The content goes to a temp file first, then a rename puts it in place in
// one step, so a crash leaves the old file or the new one, never a mix. The
// temp name is unique (process id + random), so two Marv processes saving the
// same file can't write into each other's temp file; and writes to one file
// from this process run one after the other, so an older write can't land
// after a newer one.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The last write queued for each file. */
const queues = new Map<string, Promise<void>>();

export function writePrivate(path: string, content: string): Promise<void> {
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => write(path, content));
  queues.set(path, next);
  // Forget the file once its queue is empty, so the map doesn't grow.
  void next.catch(() => {}).finally(() => queues.get(path) === next && queues.delete(path));
  return next;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600 });
    await chmod(temp, 0o600); // `mode` only applies when the file is created
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
