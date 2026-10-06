// Marv from code. Run it in a project folder:
//   OPENROUTER_API_KEY=sk-or-... bun /path/to/marv/examples/sdk.ts "what does this project do?"
//
// There's no `approve` here, so only what yolo mode vouches for runs (reading, edits outside .git, sandboxed
// commands without network); anything else goes back to the model as refused, and it carries on.
import { createSession } from "@flologixai/marv/sdk";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error("Set OPENROUTER_API_KEY first.");

const session = await createSession({
  cwd: process.cwd(),
  provider: { kind: "openrouter", apiKey },
  sources: ["project"], // the repository's AGENTS.md and .marv/ (nothing of yours)
});

for await (const event of session.send(process.argv[2] ?? "What does this project do?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "tool_start") console.log(`\n· ${event.call.name} ${event.label}`);
  if (event.type === "error") console.error(`\n${event.message}`);
}
console.log();
await session.close();
