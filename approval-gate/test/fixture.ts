import { generateKeyPairSync, randomUUID, sign } from "node:crypto"
import type { TrustAnchorFile } from "@intyga/sdk"
import { type ApprovalReceipt, canonicalIntentPayload, verificationCode } from "@intyga/verify"
import type { Config } from "../src/config.js"

export const config: Config = {
  PORT: 4400,
  TEST_API_TOKEN: "test-only-local-token-at-least-32-characters",
  INTYGA_GATEWAY_URL: "http://127.0.0.1:8787",
  INTYGA_WEB_URL: "http://localhost:3999",
  INTYGA_TARGET: "intyga-package-test",
  INTYGA_CLIENT_ID: "test-client",
  INTYGA_CLIENT_SECRET: "test-fixture-not-a-real-secret",
  INTYGA_TRUST_ANCHOR_FILE: "./trust-anchor.json",
  INTYGA_REQUIRED_APPROVALS: 1,
  INTYGA_WAIT_TIMEOUT_MS: 1000,
  INTYGA_POLL_INTERVAL_MS: 5,
}
const approver = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
const publicKey = approver.publicKey.export({ format: "der", type: "spki" }).toString("base64")
const did = "did:intyga:test-approver"
export const trust: TrustAnchorFile = {
  type: "intyga-trust-anchor",
  v: 1,
  epoch: 1,
  approvers: [{ did, publicKeys: [publicKey] }],
}
type Request = {
  target: string
  actionType: string
  actionDescription: string
  params: Record<string, unknown>
}
export function fakeGateway() {
  const entries = new Map<string, { action: Request; consumed: boolean }>()
  let state = "APPROVED"
  let tamper = false
  let consumeAllowed = true
  let consumeCount = 0
  let calls = 0
  let statusReads = 0
  const fetcher: typeof fetch = async (url, init) => {
    calls++
    const path = new URL(String(url)).pathname
    if (path === "/oauth/token") return Response.json({ access_token: "test-token", expires_in: 3600 })
    if (path === "/authorize" && init?.method === "POST") {
      const action = JSON.parse(String(init.body)) as Request
      const nonce = randomUUID()
      entries.set(nonce, { action, consumed: false })
      return Response.json({ nonce, status: "PENDING" })
    }
    if (path === "/authorize/verify") {
      consumeCount++
      const body = JSON.parse(String(init?.body)) as Request & { nonce: string }
      const entry = entries.get(body.nonce)
      if (
        !entry ||
        entry.consumed ||
        !consumeAllowed ||
        state !== "APPROVED" ||
        body.target !== entry.action.target ||
        body.actionType !== entry.action.actionType ||
        JSON.stringify(body.params) !== JSON.stringify(entry.action.params)
      )
        return Response.json({ ok: false })
      entry.consumed = true
      return Response.json({ ok: true })
    }
    const nonce = decodeURIComponent(path.slice("/authorize/".length))
    const entry = entries.get(nonce)
    if (!entry) return Response.json({ error: "not found" }, { status: 404 })
    const requester = { did: "did:intyga:test-service", attestation: null }
    const action = entry.action
    const canonicalPayload = canonicalIntentPayload({
      target: action.target,
      actionType: action.actionType,
      display: action.actionDescription,
      params: action.params,
      requester,
      requirement: {
        requiredApprovals: 1,
        requireHardwareKey: false,
        allowedAaguids: [],
        requesterCannotApprove: false,
        signerClass: "human",
      },
      nonce,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const signature = sign("sha256", Buffer.from(canonicalPayload), {
      key: approver.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64")
    const receipt: ApprovalReceipt = {
      ...action,
      canonicalPayload,
      requester,
      signerDid: did,
      signerPublicKey: publicKey,
      signature: tamper ? Buffer.alloc(64).toString("base64") : signature,
      sigAlg: "ES256",
      verificationCode: verificationCode(canonicalPayload),
    }
    statusReads++
    return Response.json({ status: entry.consumed ? "CONSUMED" : state, receipt })
  }
  return {
    fetcher,
    statusReads: () => statusReads,
    setStatus: (next: string) => {
      state = next
    },
    setTampered: () => {
      tamper = true
    },
    refuseConsume: () => {
      consumeAllowed = false
    },
    get consumes() {
      return consumeCount
    },
    get calls() {
      return calls
    },
  }
}
