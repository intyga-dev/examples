import { type IntygaClient, type TrustAnchorFile, trustAnchorApprovers } from "@intyga/sdk"
import { type ApprovalReceipt, verifyApprovalReceipt } from "@intyga/verify"
import type { Config } from "../config.js"
import type { TransferAction } from "../contracts/transfer.js"

type ApprovalSummary = {
  nonce: string
  verificationCode: string
  signerDid?: string | null
  approvalUrl?: string
}

export type GateOutcome =
  | { ok: true; approval: ApprovalSummary }
  | { ok: false; httpStatus: number; body: Record<string, unknown> }

const refuse = (httpStatus: number, body: Record<string, unknown>): GateOutcome => ({
  ok: false,
  httpStatus,
  body,
})

/**
 * Verify receipts against the service's action and trusted approvers, then consume them once.
 * Call `requestApproval` to ask and wait first, or `verifyAndConsume` for a supplied receipt.
 * Execute the action only after the gate returns `ok: true`.
 */
export function createGate(config: Config, client: IntygaClient, trust: TrustAnchorFile) {
  /** Request approval, wait for the human, then verify and consume the resulting receipt. */
  async function requestApproval(
    description: string,
    action: TransferAction,
    announce: (message: string) => void,
  ): Promise<GateOutcome> {
    announce(`Waiting for approval in INTYGA: ${config.INTYGA_WEB_URL}`)
    const result = await client.requireApproval(description, {
      ...action,
      timeoutMs: config.INTYGA_WAIT_TIMEOUT_MS,
      intervalMs: config.INTYGA_POLL_INTERVAL_MS,
    })
    const { nonce, receipt, status } = result

    if (status !== "APPROVED" || !nonce || !receipt) {
      return refuse(403, { error: "NOT_APPROVED", status, nonce })
    }
    const approvalUrl = new URL("/approve", config.INTYGA_WEB_URL)
    approvalUrl.searchParams.set("nonce", nonce)
    return verifyAndConsume(nonce, action, receipt, { approvalUrl: approvalUrl.href })
  }

  /** Verify the receipt, then consume it. The receipt may come from an untrusted caller (e.g. an agent). */
  async function verifyAndConsume(
    nonce: string,
    action: TransferAction,
    receipt: ApprovalReceipt,
    extra: { approvalUrl?: string } = {},
  ): Promise<GateOutcome> {
    // Use the service's expected action and trust anchor, never the receipt's own claims.
    const verification = verifyApprovalReceipt(
      receipt,
      {
        ...action,
        nonce,
        approvers: trustAnchorApprovers(trust),
        requirement: { requiredApprovals: config.INTYGA_REQUIRED_APPROVALS },
      },
      { expectedOrigin: trust.webauthn?.origin, expectedRpId: trust.webauthn?.rpId },
    )
    if (!verification.ok) return refuse(403, { error: "RECEIPT_REFUSED", nonce, ...extra })

    // Verifying is not redeeming: consuming makes the approval single use.
    const consumption = await client.consume(nonce, action)
    if (consumption.ok !== true) return refuse(409, { error: "CONSUMPTION_REFUSED", nonce, ...extra })

    return {
      ok: true,
      approval: { nonce, verificationCode: receipt.verificationCode, signerDid: receipt.signerDid, ...extra },
    }
  }

  return { requestApproval, verifyAndConsume }
}
export type Gate = ReturnType<typeof createGate>
