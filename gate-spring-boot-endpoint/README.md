# Example: gate a Spring Boot endpoint

A Spring Boot service whose `DELETE /databases/{name}` endpoint blocks until a human approves the
exact database with a passkey or security key, then verifies that approval offline before wiping
anything. Refusal surfaces as an exception → 403, never a 200.

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
mvn spring-boot:run
```

`INTYGA_APPROVER_KEYS` is the key set **this service** trusts, resolved from its own key
management. Verification against the key carried inside the receipt would prove only that the
receipt is self-consistent, so there is deliberately no default. Passkey receipts (the normal flow) additionally require `INTYGA_WEBAUTHN_ORIGIN` / `INTYGA_WEBAUTHN_RP_ID` — the origin and RP ID of the approval console the human signs in; the verifier fails closed without them.

Then, in another terminal:

```bash
curl -X DELETE http://localhost:8080/databases/prod-db-1
```

The curl **hangs** while the approval is pending (default 120s) — that is the point: the request
thread is the gate. Approve in the browser and the response reports the (pretend) wipe, the approval
nonce, and the verified signers. `INTYGA_TARGET` (default `prod-db-cluster-01`) names this service
in the signed payload — Target Isolation.

Try the failure paths:
- **Deny** the approval in the console → the endpoint returns
  `403 {"error":"not authorized","status":"DENIED"}`. The wipe code is unreachable on any
  non-APPROVED outcome, because `requireApprovalOrThrow` makes refusal an exception rather than a
  value a handler could forget to check.
- Let it **time out** → `403 … "status":"EXPIRED"`.
- Point `INTYGA_APPROVER_KEYS` at a key that did not sign → the gateway still says APPROVED and the
  endpoint still refuses, because the local check is what actually decides.
- Call it twice and approve both → each request creates its own challenge; an approval is
  single-use (`consume`) and cannot be replayed for the second request.

The controller verifies and consumes with the same `params` map it gated, so what the approver
signed is exactly what executes.
