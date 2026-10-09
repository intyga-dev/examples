import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { IntygaClient, parseTrustAnchorFile } from "@intyga/sdk"
import { z } from "zod"
import { deployArtifact } from "./deploy.js"

async function main() {
  const [file, environment] = z
    .tuple([z.string().min(1), z.enum(["staging", "production"])])
    .parse(process.argv.slice(2))
  const env = z
    .object({
      INTYGA_GATEWAY_URL: z.url(),
      INTYGA_CLIENT_ID: z.string().min(1),
      INTYGA_CLIENT_SECRET: z.string().min(1),
      INTYGA_TARGET: z.string().min(1),
      INTYGA_TRUST_ANCHOR_FILE: z.string().default("./trust-anchor.json"),
      INTYGA_REQUIRED_APPROVALS: z.coerce.number().int().min(1).default(1),
    })
    .parse(process.env)
  const trust = parseTrustAnchorFile(await readFile(env.INTYGA_TRUST_ANCHOR_FILE, "utf8"))
  const client = new IntygaClient({
    gatewayUrl: env.INTYGA_GATEWAY_URL,
    clientId: env.INTYGA_CLIENT_ID,
    clientSecret: env.INTYGA_CLIENT_SECRET,
  })
  const artifact = await readFile(file)
  console.error("Waiting for a passkey approval in your INTYGA console.")
  console.log(
    await deployArtifact({
      client,
      trust,
      artifact,
      environment,
      artifactName: basename(file),
      target: env.INTYGA_TARGET,
      requiredApprovals: env.INTYGA_REQUIRED_APPROVALS,
    }),
  )
}

main().catch(() => {
  console.error("Deployment refused. Check configuration, approval and the artifact path. Nothing deployed.")
  process.exitCode = 1
})
