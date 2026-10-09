// Only a child of the proxy in the documented flow. No privileged operations here.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createMcpServer } from "./mcp-server.js"

await createMcpServer().connect(new StdioServerTransport())
