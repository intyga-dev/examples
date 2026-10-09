import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "./config.js"

const config = loadConfig()
if (!config.INTYGA_CLIENT_ID || !config.INTYGA_CLIENT_SECRET) {
  console.error("Set INTYGA_CLIENT_ID and INTYGA_CLIENT_SECRET in .env.")
  process.exit(1)
}
const require = createRequire(import.meta.url)
const proxyCli = join(dirname(require.resolve("@intyga/mcp-proxy/package.json")), "dist/cli.js")
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
const child = spawn(
  process.execPath,
  [
    proxyCli,
    "--agent-id",
    config.INTYGA_TARGET,
    "--target",
    config.INTYGA_TARGET,
    "--local-policy",
    fileURLToPath(new URL("../policy.json", import.meta.url)),
    "--target-command",
    process.execPath,
    "--target-args",
    JSON.stringify([
      ...(extension === "ts" ? ["--import", "tsx"] : []),
      fileURLToPath(new URL(`./mcp-raw.${extension}`, import.meta.url)),
    ]),
  ],
  { stdio: "inherit", env: { ...process.env, INTYGA_GATEWAY_URL: config.INTYGA_GATEWAY_URL } },
)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal))
child.once("error", () => {
  console.error("Could not start the MCP proxy.")
  process.exitCode = 1
})
child.once("exit", (code) => {
  process.exitCode = code ?? 1
})
