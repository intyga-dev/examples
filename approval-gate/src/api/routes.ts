import { randomUUID } from "node:crypto"
import type { IntygaClient, TrustAnchorFile } from "@intyga/sdk"
import type { ApprovalReceipt } from "@intyga/verify"
import type { FastifyInstance, FastifyReply } from "fastify"
import type { Config } from "../config.js"
import {
  createTransferAction,
  describeTransfer,
  type Transfer,
  transferSchema,
  transferWithReceiptSchema,
} from "../contracts/transfer.js"
import { createGate, type GateOutcome } from "./gate.js"
import { transferMoney } from "./transfer.js"

type RouteDependencies = {
  config: Config
  client: IntygaClient
  trust?: TrustAnchorFile
  gatewayConfigured: boolean
  /** Receives the console URL and the outcome of every transfer. */
  log: (message: string) => void
}

export function registerRoutes(
  app: FastifyInstance,
  { config, client, trust, gatewayConfigured, log }: RouteDependencies,
) {
  const gate = trust ? createGate(config, client, trust) : undefined

  /** Logs and answers the gate's verdict. The money moves only when the gate said ok. */
  async function executeApprovedTransfer(reply: FastifyReply, outcome: GateOutcome, transfer: Transfer) {
    if (!outcome.ok) {
      log(`Transfer REFUSED (${outcome.body.error}): ${describeTransfer(transfer)}`)
      return reply.code(outcome.httpStatus).send(outcome.body)
    }
    const result = await transferMoney(transfer)
    log(
      `Transfer SUCCEEDED: ${describeTransfer(transfer)} ` +
        `(approval ${outcome.approval.nonce}, verification code ${outcome.approval.verificationCode})`,
    )
    return { ok: true, transfer: result, approval: outcome.approval }
  }

  app.get("/health", async () => ({
    ok: true,
    gatewayConfigured,
    verifierConfigured: Boolean(trust),
    target: config.INTYGA_TARGET,
  }))

  // Flow 1: request approval, wait, verify and consume, then execute.
  app.post("/transfer-money", async (req, reply) => {
    const transfer = transferSchema.parse(req.body)
    // Without a trust anchor no receipt can be verified, so refuse before asking anyone to approve.
    if (!gate) return reply.code(503).send({ error: "TRUST_ANCHOR_MISSING" })
    const outcome = await gate.requestApproval(
      `Transfer ${describeTransfer(transfer)}`,
      createTransferAction(config.INTYGA_TARGET, transfer, randomUUID()),
      log,
    )
    return executeApprovedTransfer(reply, outcome, transfer)
  })

  // Flow 2: rebuild the action from the request, verify and consume the agent's receipt, then execute.
  app.post("/transfer-money/with-receipt", async (req, reply) => {
    const { approval, ...transfer } = transferWithReceiptSchema.parse(req.body)
    if (!gate) return reply.code(503).send({ error: "TRUST_ANCHOR_MISSING" })
    const outcome = await gate.verifyAndConsume(
      approval.nonce,
      createTransferAction(config.INTYGA_TARGET, transfer, approval.approvalRequestId),
      approval.receipt as unknown as ApprovalReceipt,
    )
    return executeApprovedTransfer(reply, outcome, transfer)
  })
}
