# Example: gate a production database deletion

A ~40-line Node script that refuses to drop a database until a human cryptographically approves the exact
operation — and verifies that approval offline before proceeding.

## Run

```bash
npm install
INTYGA_GATEWAY_URL=http://localhost:8787 \
INTYGA_CLIENT_ID=<your-api-key-client-id> \
INTYGA_CLIENT_SECRET=<your-api-key-secret> \
INTYGA_APPROVER_KEYS=<base64-approver-public-key>[,<more>] \
node index.mjs prod-db-1
```

`INTYGA_APPROVER_KEYS` is required: verification must use a key **you** resolved from your own key
management. A receipt checked against the key carried inside it proves only that the receipt is
self-consistent, so there is deliberately no default. `INTYGA_TARGET` (default `prod-db-cluster-01`)
identifies the executing environment and is bound into the signature.

What happens:
1. The script calls `requireApproval("Delete production database prod-db-1", …)` and **blocks**.
2. The approver signs in the browser with a passkey or security key (Touch ID, Windows Hello,
   YubiKey) — there is nothing to install.
3. On approval, the script runs `verifyApprovalReceipt(...)` locally — confirming a human signed off on
   **these exact params** — then performs the (pretend) deletion.
4. If it's denied, times out, or the receipt doesn't verify, **nothing is deleted**.

Try the failure path: change the database name you pass on the CLI after approving for a different one
— the receipt verification fails and the deletion is refused. Changing `INTYGA_TARGET` between the
approval and the check fails the same way, which is Target Isolation doing its job.

> Uses the published package names. Inside this monorepo you can point the deps at `workspace:*` and run
> with the local gateway.
