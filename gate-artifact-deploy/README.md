# Approve a deployment by artifact digest

A small TypeScript CLI showing how **INTYGA** can gate a release on the exact artifact bytes
and destination environment. It loads the artifact once, binds its SHA-256 digest into the
approval, verifies the receipt against your trusted approvers, consumes the approval, and reports
`SIMULATED`. It does not contact a deployment provider.

## Run

Requires Node 24+ and pnpm 10. From this directory:

```sh
pnpm install --ignore-workspace --frozen-lockfile
cp .env.example .env
pnpm test
pnpm typecheck
pnpm build
printf 'demo release\n' > bundle.txt
pnpm start bundle.txt staging
```

Before starting, fill in `.env` with a human or SERVICE API key. Configure an approval rule for
target `artifact-deploy-example`, action `deploy_artifact`, and export a reviewed **online trust
anchor** from the console's Approval rules page to `trust-anchor.json`. Include the console's
WebAuthn origin and RP ID for passkey verification. No trust is taken from the receipt itself.
The required approver quorum comes from `INTYGA_REQUIRED_APPROVALS` (default 1).

Read [src/deploy.ts](src/deploy.ts) for the gate, and [src/index.ts](src/index.ts) for CLI setup.
`staging` and `production` are the only accepted environments. Each invocation adds a fresh
request ID so repeating an identical deployment requests a new approval.

## Adapting it

Replace the simulated step with an upload of the captured `snapshot`, or deploy an immutable
registry digest that your service has independently checked. Reopening the original file or
deploying a mutable tag after the human approves would break the binding. The snapshot is held
in memory, so keep demonstration artifacts small.

Use a durable execution record and the deployment provider's idempotency mechanism for real
releases. Consumption and deployment are separate operations; a crash between them does not
undo consumption or establish exactly-once execution. The gateway records approval and
consumption; your application must record the deployment outcome separately.

The tests use fresh ES256 signatures and the real verifier without a gateway or credentials.
