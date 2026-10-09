import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import Fastify from "fastify"
import { createMcpServer } from "../src/mcp-server.js"
import { config, fakeGateway } from "./fixture.js"

for (const mode of ["approved", "denied", "consume-refused", "local-deny"] as const) {
  test(`MCP wrapper: ${mode}`, async (t) => {
    const gateway = fakeGateway()
    t.mock.method(globalThis, "fetch", gateway.fetcher)
    if (mode === "denied") gateway.setStatus("DENIED")
    if (mode === "consume-refused") gateway.refuseConsume()
    const server = createMcpServer({
      gatewayUrl: config.INTYGA_GATEWAY_URL,
      clientId: config.INTYGA_CLIENT_ID,
      clientSecret: config.INTYGA_CLIENT_SECRET,
      agentId: config.INTYGA_TARGET,
      target: config.INTYGA_TARGET,
      intervalMs: 1,
      timeoutMs: 1000,
      enforcement: "local-first",
      localPolicyJson: '{"rules":[{"action":"blocked_action","effect":"deny"}]}',
    })
    const client = new Client({ name: "test", version: "1" })
    const [a, b] = InMemoryTransport.createLinkedPair()
    t.after(async () => {
      await client.close()
      await server.close()
    })
    await server.connect(b)
    await client.connect(a)
    assert.equal((await client.listTools()).tools.length, 2)
    const result = await client.callTool({
      name: mode === "local-deny" ? "blocked_action" : "demo_action",
      arguments: mode === "local-deny" ? {} : { message: "Hello", requestId: randomUUID() },
    })
    const output = JSON.stringify(result)
    assert.equal(output.includes("simulated"), mode === "approved")
    if (mode === "approved") assert.equal(gateway.consumes, 1)
    if (mode === "local-deny") assert.equal(gateway.calls, 0)
  })
}

test("MCP proxy: installed CLI starts raw server, lists tools, enforces local deny", {
  timeout: 20_000,
}, async () => {
  const client = new Client({ name: "proxy-test", version: "1" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/proxy.ts"],
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...config })
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .map(([key, value]) => [key, String(value)]),
    ),
    stderr: "inherit",
  })
  try {
    await client.connect(transport)
    assert.equal((await client.listTools()).tools.length, 2)
    await assert.rejects(client.callTool({ name: "blocked_action", arguments: {} }), /denied/i)
  } finally {
    await client.close()
    await transport.close()
  }
})

test("MCP proxy: full HTTP approval roundtrip and refusal before handler", { timeout: 30_000 }, async (t) => {
  const gateway = fakeGateway()
  const http = Fastify({ logger: false })
  http.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  )
  http.all("/*", async (req, reply) => {
    const result = await gateway.fetcher(`http://127.0.0.1${req.url}`, {
      method: req.method,
      body: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
    })
    return reply.code(result.status).send(await result.json())
  })
  const origin = await http.listen({ host: "127.0.0.1", port: 0 })
  t.after(() => http.close())
  const client = new Client({ name: "proxy-roundtrip", version: "1" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/proxy.ts"],
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...config, INTYGA_GATEWAY_URL: origin })
        .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
        .map(([key, value]) => [key, String(value)]),
    ),
    stderr: "inherit",
  })
  try {
    await client.connect(transport)
    const call = () =>
      client.callTool({
        name: "demo_action",
        arguments: { message: "Proxy roundtrip", requestId: randomUUID() },
      })
    assert.match(JSON.stringify(await call()), /simulated/)
    assert.equal(gateway.consumes, 1)
    gateway.setStatus("DENIED")
    await assert.rejects(call(), /denied/i)
    assert.equal(gateway.consumes, 1)
    gateway.setStatus("APPROVED")
    gateway.refuseConsume()
    await assert.rejects(call(), /consum/i)
  } finally {
    await client.close()
    await transport.close()
  }
})
