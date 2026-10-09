import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const proxy = process.argv.includes("--proxy")
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
const client = new Client({ name: "intyga-test-client", version: "0.1.0" })
// Child reads .env itself, so no credentials need to be placed in argv.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    "--env-file-if-exists=.env",
    "--import",
    "tsx",
    fileURLToPath(new URL(`./${proxy ? "proxy" : "mcp-stdio"}.${extension}`, import.meta.url)),
  ],
  stderr: "inherit",
})
try {
  await client.connect(transport)
  if (process.argv[2] === "list") console.log(JSON.stringify(await client.listTools(), null, 2))
  else {
    console.error(
      "Waiting for approval in INTYGA. Open the console or the approval link from the notification.",
    )
    const blocked = process.argv.includes("--blocked")
    const result = await client.callTool(
      {
        name: blocked ? "blocked_action" : "demo_action",
        arguments: blocked ? {} : { message: "Test from MCP", requestId: randomUUID() },
      },
      undefined,
      { timeout: 180_000 },
    )
    console.log(JSON.stringify(result, null, 2))
  }
} catch {
  console.error("MCP call failed. Check the configuration and the gateway.")
  process.exitCode = 1
} finally {
  await client.close()
  await transport.close()
}
