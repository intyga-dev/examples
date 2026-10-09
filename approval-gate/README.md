# INTYGA approval gate example

A TypeScript reference implementation of **`requireApproval` → `verifyApprovalReceipt` →
`consume` → execute**. It demonstrates a simulated money transfer with Fastify and the
published `@intyga/sdk` and `@intyga/verify` packages.

Start with [the approval gate](src/api/gate.ts), then [the route that executes the
transfer](src/api/routes.ts). There are two flows:

1. **Your API gates the request itself** (`POST /transfer-money`). The route asks for an
   approval, waits for a human to approve with a passkey, verifies the signed receipt locally,
   consumes it once, and only then moves the money.
2. **An AI agent asks, your API verifies** (`POST /transfer-money/with-receipt` plus an MCP
   server). The agent requests the approval and waits for the human, then sends the receipt
   to the final endpoint. That endpoint never trusts the agent: it verifies the receipt itself
   against approvers you pinned, then consumes it and moves the money.

Neither flow makes a real payment. The optional MCP wrapper and proxy examples are described
at the end.

## The core pattern

Given a configured `client`, a reviewed `trust` anchor, and validated `transfer` values, the
executing service follows these steps. The HTTP implementation maps failures to responses
instead of throwing:

```ts
const action = createTransferAction(config.INTYGA_TARGET, transfer, randomUUID())

// 1. Request approval and wait for the human's decision.
const { status, nonce, receipt } = await client.requireApproval(
  `Transfer ${describeTransfer(transfer)}`,
  {
    ...action,
    timeoutMs: config.INTYGA_WAIT_TIMEOUT_MS,
    intervalMs: config.INTYGA_POLL_INTERVAL_MS,
  },
)
if (status !== "APPROVED" || !nonce || !receipt) throw new Error("Not approved")

// 2. Verify locally against the action and approver keys your service trusts.
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
if (!verification.ok) throw new Error("Receipt refused")

// 3. Redeem the approval once, bound to the same action.
const consumption = await client.consume(nonce, action)
if (consumption.ok !== true) throw new Error("Consumption refused")

// 4. Only now execute the action.
await transferMoney(transfer)
```

An `APPROVED` status alone does not permit execution: the receipt must verify and consumption
must succeed. The API rebuilds the expected action itself, including when an agent supplies
the receipt. The shared [transfer contract](src/contracts/transfer.ts) keeps request validation
and action construction consistent between the API and agent.

## Project layout

```
src/
  app.ts                  builds the Fastify app from the pieces below
  server.ts               starts the REST server
  config.ts               environment and trust-anchor loading
  api/                    the executing service (your backend)
    routes.ts             POST /transfer-money and POST /transfer-money/with-receipt
    gate.ts               requireApproval, verifyApprovalReceipt, consume
    transfer.ts           the sensitive action itself (simulated)
    auth.ts, errors.ts    local API protection and safe error responses
  contracts/
    transfer.ts           shared validation, action construction and descriptions
  agent/                  the AI agent side
    mcp-agent.ts          MCP tools: request_transfer_approval, transfer_money
    stdio.ts              starts that MCP server over stdio
    demo.ts               scripted honest and tampered transfers
  mcp-server.ts, proxy.ts, ...   optional package-based MCP examples (see the end)
```

## Getting started

Requires Node 24+ and pnpm 10.

```sh
cd path/to/this-example
pnpm install --ignore-workspace --frozen-lockfile
pnpm run setup
pnpm test
pnpm typecheck
pnpm build
pnpm start
```

`pnpm run setup` creates `.env` with a random local API token and file mode 0600.
An existing `.env` is kept. `/health` works even without gateway credentials.
For automatic restarts during development: `pnpm dev`.
The server listens on `127.0.0.1:4400` only.

In INTYGA core, this project lives at `examples/approval-gate`. `--ignore-workspace`
keeps its dependencies and lockfile independent, just as when you copy this directory elsewhere.

For real approvals, fill in `.env`:

- `INTYGA_GATEWAY_URL` and `INTYGA_WEB_URL`: your gateway and approval console.
- `INTYGA_CLIENT_ID` and `INTYGA_CLIENT_SECRET`: a human or SERVICE key.
- `INTYGA_TARGET`: target matching your approval rule, default `intyga-package-test`.
- `INTYGA_REQUIRED_APPROVALS`: minimum quorum the verifier accepts.
- `INTYGA_WAIT_TIMEOUT_MS` / `INTYGA_POLL_INTERVAL_MS`: how long and how often a request
  waits for the human's decision.
- `INTYGA_TRUST_ANCHOR_FILE`: reviewed trust-anchor export from the console, default
  `./trust-anchor.json`. The file's `webauthn.origin` and `webauthn.rpId` are needed for
  passkey receipts. Without this file both transfer routes answer `503 TRUST_ANCHOR_MISSING`,
  because no receipt could be verified.

The approval rule, approvers and their passkeys must be configured in the gateway.
No existing secrets are copied automatically. Restart after configuration changes.

## The trust anchor (`trust-anchor.json`)

The trust anchor is the list of approvers **your service** trusts, and it is what makes receipt
verification mean anything. A receipt checked against the key inside itself would only prove it is
self-consistent, so the verifier has no default and never reads keys from the receipt or the gateway.

To create it:

1. In the INTYGA console, open **Approval rules** and export **Trust anchor for offline
   verification**.
2. Review it: check that the approvers listed are the people who should be able to approve this
   action. For high assurance, confirm a key fingerprint with the approver out of band.
3. Save it as `./trust-anchor.json` (or point `INTYGA_TRUST_ANCHOR_FILE` at it) and restart.

The file holds the approvers' DIDs and public keys, plus the console's `webauthn.origin` and
`webauthn.rpId`, which pin passkey assertions to your approval console. It contains no secrets,
but treat it as security configuration: don't fetch it at runtime, and re-export it when your
approvers or approval rules change. It is git-ignored here.

## Flow 1: your API gates the request

Load the local token into your terminal without printing it, start the server, and send a
transfer. The request **stays open** while a human approves; the console URL is printed in
the server terminal:

```sh
export TEST_API_TOKEN="$(node --env-file=.env -p 'process.env.TEST_API_TOKEN')"
curl -s http://127.0.0.1:4400/health
curl -s http://127.0.0.1:4400/transfer-money \
  -H "Authorization: Bearer $TEST_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"to":"SE4550000000058398257466","amount":250,"currency":"EUR","reference":"Invoice 42"}'
```

Open the console (or the gateway's notification link) and approve with a passkey. The response reports the simulated transfer
and the approval (nonce, verification code, signer):

```json
{
  "ok": true,
  "transfer": { "transferId": "…", "amount": 250, "currency": "EUR", "status": "SIMULATED" },
  "approval": { "nonce": "…", "verificationCode": "…", "signerDid": "…" }
}
```

| Outcome                                      | Response                                               |
| -------------------------------------------- | ------------------------------------------------------ |
| Approved, receipt verified, consumed         | `200` with the transfer                                |
| Denied or expired                            | `403 NOT_APPROVED` (with `status`)                       |
| Nobody decided within the wait timeout       | `403 NOT_APPROVED`, `status: "EXPIRED"`; no money moved  |
| Receipt fails local verification             | `403 RECEIPT_REFUSED`                                   |
| Approval already used                        | `409 CONSUMPTION_REFUSED`                               |
| No `trust-anchor.json`                       | `503 TRUST_ANCHOR_MISSING`, before requesting approval  |

`requireApproval` handles polling and returns `EXPIRED` when its wait timeout elapses.
It does not expose the challenge nonce while waiting, so the terminal points to the console;
the gateway's notification can provide a direct approval link.

The amount, destination and currency are part of what the human approves. A random
`approvalRequestId` is added so two identical transfers need two separate approvals.

## Flow 2: an AI agent asks, your API verifies

The agent never moves money and never verifies anything. It does two things, both exposed as
MCP tools by `src/agent/mcp-agent.ts`:

1. `request_transfer_approval` `{to, amount, currency}` asks the human and waits. On approval it
   returns `{ approval: { nonce, approvalRequestId, receipt } }`; otherwise an error.
2. `transfer_money` `{to, amount, currency, approval}` sends the transfer and that approval to
   the final endpoint, `POST /transfer-money/with-receipt`.

The final endpoint rebuilds the action from the values in the request, verifies the receipt
against **your** trust anchor, consumes it at the gateway, and only then moves the money. An
agent that changes the amount, replays a receipt, or forges one is refused
(`403 RECEIPT_REFUSED` or `409 CONSUMPTION_REFUSED`) and nothing moves.

```sh
pnpm start                 # terminal 1: the transfer API (the final endpoint)
pnpm mcp:agent             # terminal 2: the agent's MCP server over stdio
```

Point any MCP client at the **built** server (run `pnpm build` first). Use absolute paths, since
clients start the process from their own working directory, and the absolute Node 24 path if
`node` is not on the client's PATH. The console URL is printed on stderr:

```json
{
  "mcpServers": {
    "intyga-agent-example": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/this-example/.env",
        "/absolute/path/to/this-example/dist/agent/stdio.js"
      ]
    }
  }
}
```

The transfer API must be running (`pnpm start`). The agent reaches it at
`http://127.0.0.1:$PORT`; set `TRANSFER_API_URL` in the client's `env` if it runs elsewhere.
Don't point the client at `src/agent/stdio.ts` with `--import tsx`: that only works when the
client's working directory is this project.

The agent here uses a human or SERVICE key. An **AI_AGENT API key** additionally requires the
packages' `AgentV1Runtime` (trusted run configuration plus durable, atomic session and budget
storage), and the executing service must verify the agent context too. That adapter is not part
of this example; the gateway's requirements are not bypassed.

### Try it: honest and tampered

With the API running (`pnpm start`), `pnpm demo` runs a scripted agent through both outcomes. You
approve two requests in the INTYGA console, and the backend logs the result of each:

```sh
pnpm demo
```

1. **Honest transfer:** the agent asks for approval of 250 EUR, you approve, it sends the receipt
   with the same values. The backend logs `Transfer SUCCEEDED: 250 EUR to …`.
2. **Tampered transfer:** the agent gets a second approval for 250 EUR, then asks the backend to move
   25000 EUR with that receipt. Verification fails and the backend logs
   `Transfer REFUSED (RECEIPT_REFUSED): 25000 EUR to …`. Nothing moves and nothing is consumed.

Restart `pnpm start` after pulling changes so the backend runs the current code. If the API is not on
the default port, set `TRANSFER_API_URL`.

## Endpoints

| Endpoint                            | Function                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `GET /health`                       | Local health and whether configuration exists; does not contact the gateway |
| `POST /transfer-money`              | Flow 1: request approval, wait, verify the receipt, consume, transfer     |
| `POST /transfer-money/with-receipt` | Flow 2: verify the receipt the agent brings, consume, transfer            |

The REST server is stateless: everything needed travels in the request, and the gateway owns
approvals, single-use consumption and the real audit chain. Neither route makes a real payment.

Consumption and a real payment are separate operations: a crash after consumption can leave an
approved action unexecuted. A production integration needs durable execution records, payment
idempotency and reconciliation; single-use approval alone does not provide exactly-once payments.

## Optional: package-based MCP examples

These use `@intyga/mcp-sdk` and `@intyga/mcp-proxy` to gate an MCP tool **before its handler
runs**, with no receipt passing. Use them when you control the MCP server and don't need a
separate final endpoint.

### Wrapper

The REST server does not need to be running. The test client starts a separate MCP server:

```sh
pnpm mcp:list
pnpm mcp:call
pnpm mcp:call --blocked
```

`demo_action` waits for approval and consumes it before the handler returns
`simulated: true`. Approve in the console or via the gateway's notification.
`blocked_action` is denied by local policy without creating a request.
`demo_action` takes `{ "message": "Test", "requestId": "a-new-uuid" }`; the bundled test client
creates a new UUID per call. For an external client use `dist/mcp-stdio.js` after `pnpm build`.

### Proxy

```sh
pnpm mcp:list --proxy
pnpm mcp:call --proxy
pnpm mcp:call --proxy --blocked
```

This starts the installed `@intyga/mcp-proxy` in front of `src/mcp-raw.ts`. The raw server is a
harmless fixture; the proxy performs the approval check. `pnpm mcp:proxy` starts the same chain
for another stdio client, or use `dist/proxy.js` after `pnpm build`.

## Code style

The project is formatted and linted with [Biome](https://biomejs.dev) (`biome.json`):

```sh
pnpm format   # rewrite files in place
pnpm lint     # check formatting and lint rules
```

## Updating the packages

```sh
pnpm update --ignore-workspace @intyga/sdk @intyga/verify @intyga/mcp-sdk @intyga/mcp-proxy
pnpm typecheck
pnpm test
pnpm build
```

## Tests

The tests double as executable documentation of the guarantees. `pnpm test` requires no
gateway, database, passkey or real API key: they run the installed SDK and verifier against a
simulated gateway with freshly generated ES256 test signatures.

- `test/rest.test.ts`: Flow 1 and the final endpoint: waiting for a pending approval, denied,
  expired and timed-out approvals, tampered receipts, quorum, consume refusal, replay, changed
  amount, destination or request id, missing trust anchor, local API protection, safe errors.
- `test/agent.test.ts`: Flow 2 end to end through a real MCP client and server.
- `test/mcp.test.ts`: the package-based wrapper and a real proxy process.

Mocked signatures do not replace a live test of the browser/passkey flow.

This is an example, not production code. `.env` and `trust-anchor.json` must not be committed.
REST calls with an Origin header are rejected, and no CORS is opened.
