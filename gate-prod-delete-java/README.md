# Example: gate a production database deletion (Java)

The Java port of [`gate-prod-delete`](../gate-prod-delete): a single `main()` that refuses to drop
a database until a human cryptographically approves the exact operation — and verifies that
approval offline before proceeding.

## Run

```bash
# One-time, from the monorepo (neither package is on Maven Central yet):
mvn -f ../../packages/verify-java/pom.xml install
mvn -f ../../packages/sdk-java/pom.xml install

INTYGA_GATEWAY_URL=http://localhost:8787 \
INTYGA_CLIENT_ID=<your-api-key-client-id> \
INTYGA_CLIENT_SECRET=<your-api-key-secret> \
INTYGA_APPROVER_KEYS=<base64-approver-public-key>[,<more>] \
INTYGA_WEBAUTHN_ORIGIN=<approval-console-origin> \
INTYGA_WEBAUTHN_RP_ID=<approval-console-rp-id> \
mvn -q compile exec:java -Dexec.args="prod-db-1"
```

`INTYGA_APPROVER_KEYS` is required: verification must use a key **you** resolved from your own key
management. A receipt checked against the key carried inside it proves only that the receipt is
self-consistent, so there is deliberately no default. Passkey receipts (the normal flow) additionally require `INTYGA_WEBAUTHN_ORIGIN` / `INTYGA_WEBAUTHN_RP_ID` — the origin and RP ID of the approval console the human signs in; the verifier fails closed without them. `INTYGA_TARGET` (default
`prod-db-cluster-01`) identifies the executing environment and is bound into the signature.

What happens:
1. The program calls `requireApproval("Delete production database prod-db-1", …)` and **blocks**.
2. The approver signs in the browser with a passkey or security key (Touch ID, Windows Hello,
   YubiKey) — there is nothing to install.
3. On approval, it runs `Verify.verifyApprovalReceipt(...)` locally — confirming a human signed off
   on **these exact params**, against a key it resolved itself — then `consume()`s the approval and
   performs the (pretend) deletion.
4. If it's denied, times out, or the receipt doesn't verify, **nothing is deleted**.

Try the failure paths:
- Pass a second argument, `-Dexec.args="prod-db-1 prod-db-2"`: the approval is requested for
  `prod-db-1` but redeemed for `prod-db-2`, and the gateway refuses the consume.
- Change `INTYGA_TARGET` between the approval and the check — verification fails, which is Target
  Isolation doing its job.
- Point `INTYGA_APPROVER_KEYS` at a key that did not sign: verification refuses even though the
  gateway said APPROVED. That is the whole point of checking locally.
