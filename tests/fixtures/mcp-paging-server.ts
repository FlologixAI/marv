// A misbehaving MCP server: its tools/list always says there's another page, with the same cursor.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "paging", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "only", description: "The only tool.", inputSchema: { type: "object" } }],
  nextCursor: "again",
}));
await server.connect(new StdioServerTransport());
