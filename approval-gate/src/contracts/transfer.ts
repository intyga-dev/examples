import { z } from "zod"

const transferFields = {
  to: z.string().trim().min(1).max(64).describe("Destination account"),
  amount: z.number().positive().max(1_000_000_000),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .describe("ISO 4217 code, e.g. EUR"),
  reference: z.string().trim().max(140).optional(),
}

/** Body of POST /transfer-money: the API asks for the approval itself. */
export const transferSchema = z.strictObject(transferFields)
export type Transfer = z.infer<typeof transferSchema>

/** What an agent brings to the final endpoint after a human approved: nonce, id and signed receipt. */
export const approvalProofSchema = z.strictObject({
  nonce: z.string().min(1).max(200),
  approvalRequestId: z.uuid(),
  receipt: z.record(z.string(), z.json()),
})
export type ApprovalProof = z.infer<typeof approvalProofSchema>

/** Body of POST /transfer-money/with-receipt: the transfer plus the proof of approval. */
export const transferWithReceiptSchema = z.strictObject({ ...transferFields, approval: approvalProofSchema })

/** Bind the approval to these exact values and a unique request, even for identical transfers. */
export function createTransferAction(target: string, transfer: Transfer, approvalRequestId: string) {
  return {
    target,
    actionType: "transfer_money",
    params: { ...transfer, approvalRequestId },
  }
}
export type TransferAction = ReturnType<typeof createTransferAction>

export function describeTransfer(transfer: Transfer) {
  return `${transfer.amount} ${transfer.currency} to ${transfer.to}`
}
