import { createHash, randomUUID } from "node:crypto"
import { type IntygaClient, type TrustAnchorFile, trustAnchorApprovers } from "@intyga/sdk"
import { verifyApprovalReceipt } from "@intyga/verify"
import { z } from "zod"

const instruction = z.object({
  target: z.string().trim().min(1),
  environment: z.enum(["staging", "production"]),
  artifactName: z.string().min(1).max(255),
  requiredApprovals: z.number().int().min(1),
})

/** Simulate deploying the exact bytes approved; never resolve a mutable tag after approval. */
export async function deployArtifact(input: {
  client: Pick<IntygaClient, "requireApproval" | "consume">
  trust: TrustAnchorFile
  target: string
  environment: string
  artifactName: string
  artifact: Uint8Array
  requiredApprovals: number
}) {
  const { target, environment, artifactName, requiredApprovals } = instruction.parse(input)
  // Snapshot before waiting. A real deploy adapter must upload this snapshot, not re-read the path.
  const snapshot = Uint8Array.from(input.artifact)
  const params = {
    environment,
    artifactName,
    artifactSha256: createHash("sha256").update(snapshot).digest("hex"),
    requestId: randomUUID(),
  }
  const action = { target, actionType: "deploy_artifact", params }
  const approval = await input.client.requireApproval(
    `Deploy ${artifactName} to ${environment} (SHA-256 ${params.artifactSha256})`,
    { ...action, timeoutMs: 120_000, intervalMs: 1_000 },
  )
  if (approval.status !== "APPROVED" || !approval.nonce || !approval.receipt) {
    throw new Error("NOT_APPROVED")
  }
  const check = verifyApprovalReceipt(
    approval.receipt,
    {
      ...action,
      nonce: approval.nonce,
      approvers: trustAnchorApprovers(input.trust),
      requirement: { requiredApprovals },
    },
    { expectedOrigin: input.trust.webauthn?.origin, expectedRpId: input.trust.webauthn?.rpId },
  )
  if (!check.ok) throw new Error("RECEIPT_REFUSED")
  const consumed = await input.client.consume(approval.nonce, action)
  if (consumed.ok !== true) throw new Error("CONSUMPTION_REFUSED")

  // Replace ONLY this simulated step with an idempotent deploy of snapshot.
  return { status: "SIMULATED" as const, target, ...params }
}
