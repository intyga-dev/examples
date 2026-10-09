import { IntygaClient } from "@intyga/sdk"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadConfig } from "../config.js"
import { createAgentServer, httpTransferApi } from "./mcp-agent.js"

// Run with the transfer API already started (pnpm start / pnpm dev). stdout is the MCP protocol,
// so the approval console link goes to stderr.
try {
  const config = loadConfig()
  if (!config.INTYGA_CLIENT_ID || !config.INTYGA_CLIENT_SECRET) throw new Error("Missing credentials")
  const client = new IntygaClient({
    gatewayUrl: config.INTYGA_GATEWAY_URL,
    clientId: config.INTYGA_CLIENT_ID,
    clientSecret: config.INTYGA_CLIENT_SECRET,
  })
  const apiUrl = process.env.TRANSFER_API_URL ?? `http://127.0.0.1:${config.PORT}`
  const server = createAgentServer({
    config,
    client,
    callApi: httpTransferApi(apiUrl, config.TEST_API_TOKEN),
    announce: (message) => console.error(message),
  })
  await server.connect(new StdioServerTransport())
} catch {
  console.error("Agent MCP startup failed. Check .env and the gateway credentials.")
  process.exitCode = 1
}
