import { randomUUID } from "node:crypto"
import type { Transfer } from "../contracts/transfer.js"

/**
 * The sensitive action the gate protects. In a real service this would call your bank or
 * ledger. Here it only simulates, so the example is safe to run.
 */
export async function transferMoney(transfer: Transfer) {
  return { transferId: randomUUID(), ...transfer, status: "SIMULATED" as const }
}
