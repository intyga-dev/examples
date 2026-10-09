import { type IntygaConfig, intygafyServer } from "@intyga/mcp-sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

export function createMcpServer(gate?: IntygaConfig) {
  const server = new McpServer({ name: "intyga-package-test", version: "0.1.0" })
  if (gate) intygafyServer(server, gate)
  server.registerTool(
    "demo_action",
    {
      description: "Harmless test simulation. Returns the parameters after INTYGA approval.",
      inputSchema: { message: z.string().min(1).max(200), requestId: z.uuid() },
    },
    async (params) => ({ content: [{ type: "text", text: JSON.stringify({ simulated: true, ...params }) }] }),
  )
  server.registerTool(
    "blocked_action",
    {
      description: "Demonstrates refusal by local policy before the handler runs.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: "Unexpected execution" }] }),
  )
  return server
}
