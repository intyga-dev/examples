import { readFileSync } from "node:fs"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "./config.js"
import { createMcpServer } from "./mcp-server.js"

try {
  const config = loadConfig()
  if (!config.INTYGA_CLIENT_ID || !config.INTYGA_CLIENT_SECRET) throw new Error("Missing credentials")
  const server = createMcpServer({
    gatewayUrl: config.INTYGA_GATEWAY_URL,
    clientId: config.INTYGA_CLIENT_ID,
    clientSecret: config.INTYGA_CLIENT_SECRET,
    agentId: config.INTYGA_TARGET,
    target: config.INTYGA_TARGET,
    enforcement: "local-first",
    localPolicyJson: readFileSync(new URL("../policy.json", import.meta.url), "utf8"),
  })
  await server.connect(new StdioServerTransport())
} catch {
  console.error("MCP startup failed. Check .env and the gateway credentials.")
  process.exitCode = 1
}
