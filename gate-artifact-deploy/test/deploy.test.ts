import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import test from "node:test"
import type { IntygaClient, TrustAnchorFile } from "@intyga/sdk"
import { type ApprovalReceipt, canonicalIntentPayload, verificationCode } from "@intyga/verify"
import { deployArtifact } from "../src/deploy.js"

function fixture(options: { tamper?: string; consume?: boolean; denied?: boolean } = {}) {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64")
  const did = "did:intyga:example-approver"
  const trust: TrustAnchorFile = {
    type: "intyga-trust-anchor",
    v: 1,
    epoch: 1,
    approvers: [{ did, publicKeys: [publicKey] }],
  }
  let consumptions = 0
  let requested: Record<string, unknown> | undefined
  const client: Pick<IntygaClient, "requireApproval" | "consume"> = {
    async requireApproval(display, action) {
      assert.ok(action?.params)
      const params = structuredClone(action.params)
      requested = params
      if (options.tamper) params[options.tamper] = "changed-after-approval"
      const nonce = randomUUID()
      const requester = { did: "did:intyga:example-service", attestation: null }
      const requirement = {
        requiredApprovals: 1,
        requireHardwareKey: false,
        allowedAaguids: [],
        requesterCannotApprove: false,
        signerClass: "human" as const,
      }
      const canonicalPayload = canonicalIntentPayload({
        target: action.target,
        actionType: action.actionType ?? "",
        display,
        params,
        nonce,
        requester,
        requirement,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      const receipt: ApprovalReceipt = {
        target: action.target,
        actionType: action.actionType ?? "",
        actionDescription: display,
        params,
        requester,
        canonicalPayload,
        signerDid: did,
        signerPublicKey: publicKey,
        signature: sign("sha256", Buffer.from(canonicalPayload), {
          key: key.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64"),
        sigAlg: "ES256",
        verificationCode: verificationCode(canonicalPayload),
      }
      return { nonce, status: options.denied ? "DENIED" : "APPROVED", receipt }
    },
    async consume() {
      consumptions++
      return { ok: options.consume !== false && consumptions === 1 }
    },
  }
  return {
    input: {
      client,
      trust,
      target: "artifact-deploy-example",
      environment: "staging",
      artifactName: "release.tar",
      artifact: Buffer.from("frozen release"),
      requiredApprovals: 1,
    },
    consumptions: () => consumptions,
    requested: () => requested,
  }
}

test("binds the artifact digest and environment, verifies and consumes before simulation", async () => {
  const f = fixture()
  const result = await deployArtifact(f.input)
  assert.equal(result.status, "SIMULATED")
  assert.equal(result.artifactSha256, createHash("sha256").update("frozen release").digest("hex"))
  assert.equal(result.environment, "staging")
  assert.equal(f.consumptions(), 1)
  assert.deepEqual(f.requested(), {
    artifactName: result.artifactName,
    artifactSha256: result.artifactSha256,
    environment: result.environment,
    requestId: result.requestId,
  })
})

for (const field of ["artifactSha256", "environment", "artifactName", "requestId"]) {
  test(`refuses a receipt for a different ${field} before consumption`, async () => {
    const f = fixture({ tamper: field })
    await assert.rejects(deployArtifact(f.input), /RECEIPT_REFUSED/)
    assert.equal(f.consumptions(), 0)
  })
}

test("refuses denial, untrusted approvers and insufficient quorum", async () => {
  const denied = fixture({ denied: true })
  await assert.rejects(deployArtifact(denied.input), /NOT_APPROVED/)
  assert.equal(denied.consumptions(), 0)
  const untrusted = fixture()
  untrusted.input.trust.approvers[0]!.did = "did:intyga:someone-else"
  await assert.rejects(deployArtifact(untrusted.input), /RECEIPT_REFUSED/)
  assert.equal(untrusted.consumptions(), 0)
  const quorum = fixture()
  await assert.rejects(deployArtifact({ ...quorum.input, requiredApprovals: 2 }), /RECEIPT_REFUSED/)
  assert.equal(quorum.consumptions(), 0)
})

test("refuses consumption failure without reporting a deployment", async () => {
  const f = fixture({ consume: false })
  await assert.rejects(deployArtifact(f.input), /CONSUMPTION_REFUSED/)
  assert.equal(f.consumptions(), 1)
})

test("validates the destination before asking for approval", async () => {
  const f = fixture()
  await assert.rejects(deployArtifact({ ...f.input, environment: "anything" }))
  assert.equal(f.requested(), undefined)
})
