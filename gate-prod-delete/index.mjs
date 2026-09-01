// Gate a production database deletion behind a signed human approval.
// Run: INTYGA_GATEWAY_URL=... INTYGA_CLIENT_ID=... INTYGA_CLIENT_SECRET=... \
//      INTYGA_APPROVER_KEYS=<base64>,<base64> \
//      INTYGA_WEBAUTHN_ORIGIN=https://console.example.com INTYGA_WEBAUTHN_RP_ID=console.example.com \
//      node index.mjs prod-db-1
import { IntygaClient } from "@intyga/sdk"
import { verifyApprovalReceipt } from "@intyga/verify"

const database = process.argv[2] ?? "prod-db-1"

// The execution target — who WE are. Bound into the signed payload (DIV Target Isolation) so an
// approval minted for another service cannot be replayed here.
const target = process.env.INTYGA_TARGET ?? "prod-db-cluster-01"

// The approver keys THIS caller trusts, resolved from our own key management. Never the key inside
// the receipt: a receipt checked against its own embedded key proves nothing.
const approverKeys = (process.env.INTYGA_APPROVER_KEYS ?? "").split(",").filter(Boolean)
if (approverKeys.length === 0) {
  console.error("Set INTYGA_APPROVER_KEYS to one or more base64 approver public keys.")
  process.exit(1)
}

const intyga = new IntygaClient({
  gatewayUrl: process.env.INTYGA_GATEWAY_URL ?? "http://localhost:8787",
  clientId: process.env.INTYGA_CLIENT_ID,
  clientSecret: process.env.INTYGA_CLIENT_SECRET,
})

// The one dangerous thing we never want to happen unsupervised.
async function reallyDropTheDatabase(t) {
  console.log(`💥 [pretend] dropping database ${t} …`)
}

async function main() {
  const action = { target, actionType: "wipe_production", params: { database } }

  console.log(`Requesting human approval to wipe ${database} … (approve with a passkey or security key)`)
  const approval = await intyga.requireApproval(`Delete production database ${database}`, action)

  if (approval.status !== "APPROVED") {
    console.error(`❌ Not authorized: ${approval.status}. Aborting — nothing was deleted.`)
    process.exit(1)
  }

  // Prove locally that a human signed off on THIS exact instruction (no Intyga secret).
  // target, nonce and approvers are asserted from OUR side, never read from the receipt.
  const check = verifyApprovalReceipt(
    approval.receipt,
    {
      ...action,
      nonce: approval.nonce,
      approvers: { publicKeys: approverKeys },
    },
    {
      // REQUIRED for passkey receipts: pin the assertion to the approval console the human signed in
      // (your deployment's WEBAUTHN_ORIGIN / WEBAUTHN_RP_ID). The verifier fails closed without them.
      expectedOrigin: process.env.INTYGA_WEBAUTHN_ORIGIN,
      expectedRpId: process.env.INTYGA_WEBAUTHN_RP_ID,
    },
  )
  if (!check.ok) {
    console.error(`❌ Receipt did not verify: ${check.reason}. Aborting.`)
    process.exit(1)
  }

  console.log(
    `✅ Verified approval — code ${approval.receipt.verificationCode}, signer ${approval.receipt.signerDid}`,
  )
  await reallyDropTheDatabase(database)
  console.log("Done.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
