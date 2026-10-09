import { readFileSync } from "node:fs"
import { assertGatewayUrl, parseTrustAnchorFile, type TrustAnchorFile } from "@intyga/sdk"
import { z } from "zod"

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4400),
  TEST_API_TOKEN: z.string().min(32),
  INTYGA_GATEWAY_URL: z.string().default("http://localhost:8787"),
  INTYGA_WEB_URL: z.url().default("http://localhost:3999"),
  INTYGA_TARGET: z.string().trim().min(1).default("intyga-package-test"),
  INTYGA_CLIENT_ID: z.string().default(""),
  INTYGA_CLIENT_SECRET: z.string().default(""),
  INTYGA_TRUST_ANCHOR_FILE: z.string().default("./trust-anchor.json"),
  INTYGA_REQUIRED_APPROVALS: z.coerce.number().int().min(1).default(1),
  INTYGA_WAIT_TIMEOUT_MS: z.coerce.number().int().min(1).max(600_000).default(120_000),
  INTYGA_POLL_INTERVAL_MS: z.coerce.number().int().min(1).max(60_000).default(1_000),
})
export type Config = z.infer<typeof configSchema>

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env)
  if (!result.success) throw new Error("Invalid configuration. Run pnpm run setup and check .env.")
  assertGatewayUrl(result.data.INTYGA_GATEWAY_URL)
  return result.data
}

export function loadTrust(config: Config): TrustAnchorFile | undefined {
  try {
    return parseTrustAnchorFile(readFileSync(config.INTYGA_TRUST_ANCHOR_FILE, "utf8"))
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw new Error("Trust anchor could not be read or validated.")
  }
}
