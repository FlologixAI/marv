// A small MCP server for the tests, built with the SDK's server side. Run as a
// script it speaks stdio; makeServer() is also served over HTTP by the tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function makeServer(): McpServer {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo the text back.", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerTool(
    "lookup",
    { description: "Look a word up.", inputSchema: { word: z.string() }, annotations: { readOnlyHint: true } },
    async ({ word }) => ({ content: [{ type: "text", text: `${word}: a word` }] }),
  );
  server.registerTool("fail", { description: "Always fails." }, async () => ({ content: [{ type: "text", text: "it broke" }], isError: true }));
  server.registerTool("picture", { description: "Returns an image." }, async () => ({
    content: [
      { type: "text", text: "here it is" },
      { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
    ],
  }));
  server.registerTool("slow", { description: "Takes 5 seconds." }, async () => {
    await Bun.sleep(5000);
    return { content: [{ type: "text", text: "finally" }] };
  });
  server.registerTool("env", { description: "Shows whether a secret reached the server." }, async () => ({
    content: [{ type: "text", text: `key=${process.env.OPENROUTER_API_KEY ?? ""} custom=${process.env.CUSTOM ?? ""}` }],
  }));
  server.registerTool("progress", { description: "Takes 1.5 s, reporting progress every 0.3 s." }, async (extra) => {
    const token = extra._meta?.progressToken;
    for (let i = 1; i <= 5; i++) {
      await Bun.sleep(300);
      if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: 5 } });
    }
    return { content: [{ type: "text", text: "made it" }] };
  });
  server.registerTool("cwd", { description: "Shows the folder the server runs in." }, async () => ({ content: [{ type: "text", text: process.cwd() }] }));
  return server;
}

if (import.meta.main) {
  console.error("test-server starting"); // stderr: must not reach Marv's screen
  await makeServer().connect(new StdioServerTransport());
}
