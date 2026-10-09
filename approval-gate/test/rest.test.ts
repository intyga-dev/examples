import assert from "node:assert/strict"
import { test } from "node:test"
import { IntygaClient } from "@intyga/sdk"
import { createApp } from "../src/app.js"
import { config, fakeGateway, trust } from "./fixture.js"

const headers = { authorization: `Bearer ${config.TEST_API_TOKEN}` }
const transfer = { to: "SE4550000000058398257466", amount: 250, currency: "EUR", reference: "Invoice 42" }
const post = (app: ReturnType<typeof createApp>, payload: unknown = transfer) =>
  app.inject({ method: "POST", url: "/transfer-money", headers, payload: payload as object })
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))
/** Waits until the gate has polled for the decision at least twice, i.e. it is really waiting. */
const waitingFor = async (gateway: ReturnType<typeof fakeGateway>) => {
  for (let i = 0; i < 200 && gateway.statusReads() < 2; i++) await tick(10)
}

test("transfer-money: waits for approval, verifies the receipt, consumes once, then moves the money", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const links: string[] = []
  const app = createApp(config, trust, (message) => links.push(message))
  t.after(() => app.close())
  gateway.setStatus("PENDING")
  const pending = post(app)
  await waitingFor(gateway)
  assert.equal(links.length, 1)
  assert.match(links[0] ?? "", /Waiting for approval in INTYGA: http:\/\/localhost:3999/)
  assert.ok(gateway.statusReads() > 1, "the route keeps polling while the approval is pending")
  assert.equal(gateway.consumes, 0, "nothing is consumed before the approval")
  gateway.setStatus("APPROVED")
  const response = await pending
  assert.equal(response.statusCode, 200)
  const body = response.json()
  assert.equal(body.ok, true)
  assert.equal(body.transfer.status, "SIMULATED")
  assert.equal(body.transfer.amount, 250)
  assert.equal(typeof body.approval.verificationCode, "string")
  assert.equal(gateway.consumes, 1)
})

test("transfer-money: each transfer needs its own approval, even when identical", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  t.after(() => app.close())
  const first = (await post(app)).json()
  const second = (await post(app)).json()
  assert.notEqual(first.approval.nonce, second.approval.nonce)
  assert.equal(gateway.consumes, 2)
})

test("transfer-money: auth, browser origins and invalid bodies fail before the gateway", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  t.after(() => app.close())
  assert.equal((await app.inject({ url: "/health" })).statusCode, 200)
  assert.equal(
    (await app.inject({ method: "POST", url: "/transfer-money", payload: transfer })).statusCode,
    401,
  )
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/transfer-money",
        payload: transfer,
        headers: { ...headers, origin: "https://example.test" },
      })
    ).statusCode,
    401,
  )
  for (const bad of [
    { ...transfer, amount: -5 },
    { ...transfer, amount: "250" },
    { ...transfer, currency: "euro" },
    { ...transfer, target: "another-rp" },
    { to: transfer.to },
  ]) {
    assert.equal((await post(app, bad)).statusCode, 400)
  }
  assert.equal(gateway.calls, 0)
})

const refusals = [
  { mode: "DENIED", status: 403, consumes: 0 },
  { mode: "EXPIRED", status: 403, consumes: 0 },
  { mode: "PENDING", status: 403, consumes: 0 },
  { mode: "tampered", status: 403, consumes: 0 },
  { mode: "quorum", status: 403, consumes: 0 },
  { mode: "consume-refused", status: 409, consumes: 1 },
  { mode: "missing-trust", status: 503, consumes: 0 },
] as const
for (const { mode, status, consumes } of refusals) {
  test(`transfer-money: ${mode} never moves the money`, async (t) => {
    const gateway = fakeGateway()
    t.mock.method(globalThis, "fetch", gateway.fetcher)
    const app = createApp(
      { ...config, INTYGA_WAIT_TIMEOUT_MS: 50, INTYGA_REQUIRED_APPROVALS: mode === "quorum" ? 2 : 1 },
      mode === "missing-trust" ? undefined : trust,
    )
    t.after(() => app.close())
    if (mode === "tampered") gateway.setTampered()
    if (mode === "consume-refused") gateway.refuseConsume()
    if (["DENIED", "EXPIRED", "PENDING"].includes(mode)) gateway.setStatus(mode)
    const response = await post(app)
    assert.equal(response.statusCode, status)
    assert.equal(response.json().transfer, undefined)
    assert.equal(gateway.consumes, consumes)
    if (mode === "PENDING") {
      assert.equal(response.json().error, "NOT_APPROVED")
      assert.equal(response.json().status, "EXPIRED")
    }
    if (mode === "missing-trust")
      assert.equal(gateway.calls, 0, "no approval is requested without a trust anchor")
  })
}

test("transfer-money: a denial that arrives while waiting stops the transfer", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  t.after(() => app.close())
  gateway.setStatus("PENDING")
  const pending = post(app)
  await waitingFor(gateway)
  gateway.setStatus("DENIED")
  const response = await pending
  assert.equal(response.statusCode, 403)
  assert.equal(response.json().status, "DENIED")
  assert.equal(gateway.consumes, 0)
})

test("transfer-money: a tampered receipt that arrives after the wait is refused before consume", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  t.after(() => app.close())
  gateway.setStatus("PENDING")
  const pending = post(app)
  await waitingFor(gateway)
  gateway.setTampered()
  gateway.setStatus("APPROVED")
  const response = await pending
  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error, "RECEIPT_REFUSED")
  assert.equal(gateway.consumes, 0)
})

test("transfer-money: missing credentials and upstream failures return safe errors", async (t) => {
  const app = createApp(config, trust)
  const unconfigured = createApp({ ...config, INTYGA_CLIENT_ID: "", INTYGA_CLIENT_SECRET: "" })
  t.after(() => Promise.all([app.close(), unconfigured.close()]))
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("sensitive-value-must-not-escape")
  })
  assert.equal((await post(unconfigured)).statusCode, 503)
  const failed = await post(app)
  assert.equal(failed.statusCode, 502)
  assert.ok(!failed.body.includes("sensitive-value"))
})

test("transfer-money: an approved result must include both a nonce and a receipt", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  t.after(() => app.close())

  const approval = await approvedProof()
  for (const result of [
    { status: "APPROVED", nonce: approval.nonce },
    { status: "APPROVED", receipt: approval.receipt },
  ]) {
    const requireApproval = t.mock.method(IntygaClient.prototype, "requireApproval", async () => result)
    const response = await post(app)
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error, "NOT_APPROVED")
    assert.equal(response.json().transfer, undefined)
    assert.equal(gateway.consumes, 0)
    requireApproval.mock.restore()
  }
})

// --- Final endpoint for agents: POST /transfer-money/with-receipt ---------------------------

/** What an agent does: asks the gateway for an approval of exact values and collects the receipt. */
async function approvedProof(approvalRequestId = crypto.randomUUID(), values = transfer) {
  const client = new IntygaClient({
    gatewayUrl: config.INTYGA_GATEWAY_URL,
    clientId: config.INTYGA_CLIENT_ID,
    clientSecret: config.INTYGA_CLIENT_SECRET,
  })
  const { nonce } = await client.authorize("Agent transfer", {
    target: config.INTYGA_TARGET,
    actionType: "transfer_money",
    params: { ...values, approvalRequestId },
  })
  return { nonce, approvalRequestId, receipt: (await client.status(nonce)).receipt }
}
const postReceipt = (app: ReturnType<typeof createApp>, payload: unknown) =>
  app.inject({ method: "POST", url: "/transfer-money/with-receipt", headers, payload: payload as object })

test("with-receipt: verifies the agent-supplied receipt, consumes once, then moves the money", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  t.after(() => app.close())
  const response = await postReceipt(app, { ...transfer, approval: await approvedProof() })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().transfer.status, "SIMULATED")
  assert.equal(gateway.consumes, 1)
})

test("with-receipt: a receipt cannot be replayed", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  t.after(() => app.close())
  const body = { ...transfer, approval: await approvedProof() }
  assert.equal((await postReceipt(app, body)).statusCode, 200)
  const replay = await postReceipt(app, body)
  assert.equal(replay.statusCode, 409)
  assert.equal(replay.json().transfer, undefined)
})

test("with-receipt: an agent cannot change the amount, destination or request id after approval", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  t.after(() => app.close())
  const approval = await approvedProof()
  for (const changed of [
    { ...transfer, amount: 25_000 },
    { ...transfer, to: "SE0000000000000000000000" },
    { ...transfer, currency: "USD" },
  ]) {
    const response = await postReceipt(app, { ...changed, approval })
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error, "RECEIPT_REFUSED")
  }
  const other = await postReceipt(app, {
    ...transfer,
    approval: { ...approval, approvalRequestId: crypto.randomUUID() },
  })
  assert.equal(other.statusCode, 403)
  assert.equal(gateway.consumes, 0)
})

test("with-receipt: tampered receipts, missing trust and malformed bodies are refused", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const app = createApp(config, trust)
  const noTrust = createApp(config, undefined)
  t.after(() => Promise.all([app.close(), noTrust.close()]))
  gateway.setTampered()
  const tampered = await postReceipt(app, { ...transfer, approval: await approvedProof() })
  assert.equal(tampered.statusCode, 403)
  assert.equal(gateway.consumes, 0)
  assert.equal((await postReceipt(noTrust, { ...transfer, approval: await approvedProof() })).statusCode, 503)
  assert.equal((await postReceipt(app, { ...transfer })).statusCode, 400)
  assert.equal((await postReceipt(app, { ...transfer, approval: { nonce: "x" } })).statusCode, 400)
})

test("backend logs SUCCEEDED for a verified transfer and REFUSED for an altered one", async (t) => {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const lines: string[] = []
  const app = createApp(config, trust, (line) => lines.push(line))
  t.after(() => app.close())
  const approval = await approvedProof()
  await postReceipt(app, { ...transfer, approval })
  const altered = await approvedProof()
  await postReceipt(app, { ...transfer, amount: 25_000, approval: altered })
  assert.match(lines.join("\n"), /Transfer SUCCEEDED: 250 EUR/)
  assert.match(lines.join("\n"), /Transfer REFUSED \(RECEIPT_REFUSED\): 25000 EUR/)
})
