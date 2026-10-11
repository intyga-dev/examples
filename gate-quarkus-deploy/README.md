# Example: gate a Quarkus deploy endpoint

A Quarkus service whose `POST /deploy` endpoint blocks until a human approves the exact repo + SHA
with a passkey or security key, then verifies that approval offline before shipping. Refusal maps to
a 403 via a JAX-RS `ExceptionMapper`, never a 200.

## Run

```bash
# One-time, from the monorepo: install the tenant-binding-enabled candidate artifacts.
mvn -f ../../packages/verify-java/pom.xml install
mvn -f ../../packages/sdk-java/pom.xml install

INTYGA_GATEWAY_URL=http://localhost:8787 \
INTYGA_CLIENT_ID=<your-api-key-client-id> \
INTYGA_CLIENT_SECRET=<your-api-key-secret> \
INTYGA_APPROVER_KEYS=<base64-approver-public-key>[,<more>] \
INTYGA_TENANT_ID=<tenant-id-from-your-own-configuration> \
INTYGA_WEBAUTHN_ORIGIN=<approval-console-origin> \
INTYGA_WEBAUTHN_RP_ID=<approval-console-rp-id> \
mvn quarkus:dev
```

These examples require the tenant-binding release of `com.intyga:intyga-sdk` (the current candidate is 2.0.0), which provides `Expected.withTenantId`. Until that candidate is published, install both packages from this checkout as above. Align the dependency version with the published tenant-binding release when it ships.

`INTYGA_APPROVER_KEYS` is the key set **this service** trusts, resolved from its own key
management — never the one carried inside the receipt, so there is deliberately no default. Passkey receipts (the normal flow) additionally require `INTYGA_WEBAUTHN_ORIGIN` / `INTYGA_WEBAUTHN_RP_ID` — the origin and RP ID of the approval console the human signs in; the verifier fails closed without them.

Then, in another terminal:

```bash
curl -X POST http://localhost:8080/deploy \
  -H 'content-type: application/json' \
  -d '{"repo":"acme/api","sha":"9f2c1e7"}'
```

The curl **hangs** while the approval is pending — the request thread is the gate. Approve in the
browser and the response reports the (pretend) deploy. `INTYGA_TARGET` (default `prod-cluster-01`)
names this cluster in the signed payload — Target Isolation, the same vocabulary as the
[`ci-cd-github-action`](../ci-cd-github-action) example.

Try the failure paths: request a deploy for one SHA and **deny** it →
`403 {"error":"not authorized","status":"DENIED"}`, nothing ships. Point `INTYGA_APPROVER_KEYS` at a
key that did not sign and the deploy is refused even though the gateway approved it — the local
check is what decides. The resource verifies and consumes with the same `{repo, sha}` it gated, so
the approver's signature covers exactly what ships.

Receipt verification now also requires `INTYGA_TENANT_ID`, supplied from this relying party’s own configuration. The verifier refuses a receipt for another tenant and never uses the receipt itself as the expected tenant.
