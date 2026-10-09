import assert from "node:assert/strict"
import { test } from "node:test"
import { IntygaClient } from "@intyga/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createAgentServer } from "../src/agent/mcp-agent.js"
import { createApp } from "../src/app.js"
import { config, fakeGateway, trust } from "./fixture.js"

const transfer = { to: "SE4550000000058398257466", amount: 250, currency: "EUR" }

/** Wires an agent (MCP client) to the agent server, whose final endpoint is the real app. */
async function setup(t: import("node:test").TestContext, overrides: Partial<typeof config> = {}) {
  const gateway = fakeGateway()
  t.mock.method(globalThis, "fetch", gateway.fetcher)
  const cfg = { ...config, ...overrides }
  const app = createApp(cfg, trust)
  const client = new IntygaClient({
    gatewayUrl: cfg.INTYGA_GATEWAY_URL,
    clientId: cfg.INTYGA_CLIENT_ID,
    clientSecret: cfg.INTYGA_CLIENT_SECRET,
  })
  const server = createAgentServer({
    config: cfg,
    client,
    callApi: async (path, body) => {
      const response = await app.inject({
        method: "POST",
        url: path,
        payload: body as object,
        headers: { authorization: `Bearer ${cfg.TEST_API_TOKEN}` },
      })
      return { status: response.statusCode, body: response.json() }
    },
  })
  const agent = new Client({ name: "agent", version: "1" })
  const [a, b] = InMemoryTransport.createLinkedPair()
  t.after(async () => {
    await agent.close()
    await server.close()
    await app.close()
  })
  await server.connect(b)
  await agent.connect(a)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await agent.callTool({ name, arguments: args })
    const content = result.content as { text: string }[]
    return { isError: Boolean(result.isError), data: JSON.parse(content[0]?.text ?? "null") }
  }
  return { gateway, call }
}

test("agent: asks for approval, then the final endpoint verifies the receipt and moves the money", async (t) => {
  const { gateway, call } = await setup(t)
  const approval = await call("request_transfer_approval", transfer)
  assert.equal(approval.isError, false)
  assert.equal(gateway.consumes, 0, "asking for approval consumes nothing")
  const done = await call("transfer_money", { ...transfer, approval: approval.data.approval })
  assert.equal(done.isError, false)
  assert.equal(done.data.transfer.status, "SIMULATED")
  assert.equal(gateway.consumes, 1)
})

test("agent: a denied or unanswered approval gives the agent nothing to send", async (t) => {
  for (const [state, error] of [
    ["DENIED", "NOT_APPROVED"],
    ["PENDING", "NOT_APPROVED"],
  ] as const) {
    const { gateway, call } = await setup(t, { INTYGA_WAIT_TIMEOUT_MS: 30 })
    gateway.setStatus(state)
    const result = await call("request_transfer_approval", transfer)
    assert.equal(result.isError, true)
    assert.equal(result.data.error, error)
    assert.equal(result.data.approval, undefined)
  }
})

test("agent: the final endpoint refuses a changed amount, a replay, and a forged receipt", async (t) => {
  const { gateway, call } = await setup(t)
  const { data } = await call("request_transfer_approval", transfer)
  const bigger = await call("transfer_money", { ...transfer, amount: 25_000, approval: data.approval })
  assert.equal(bigger.isError, true)
  assert.equal(bigger.data.error, "RECEIPT_REFUSED")
  const forged = {
    ...data.approval,
    receipt: { ...data.approval.receipt, signature: Buffer.alloc(64).toString("base64") },
  }
  assert.equal(
    (await call("transfer_money", { ...transfer, approval: forged })).data.error,
    "RECEIPT_REFUSED",
  )
  assert.equal(gateway.consumes, 0)
  assert.equal((await call("transfer_money", { ...transfer, approval: data.approval })).isError, false)
  const replay = await call("transfer_money", { ...transfer, approval: data.approval })
  assert.equal(replay.isError, true)
  assert.equal(replay.data.error, "CONSUMPTION_REFUSED")
})
