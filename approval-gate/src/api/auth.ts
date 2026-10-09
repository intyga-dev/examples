import { timingSafeEqual } from "node:crypto"
import type { FastifyInstance } from "fastify"
import type { Config } from "../config.js"

/**
 * Protects the local API: every route except /health needs the bearer token,
 * browser requests (Origin header) are refused, and gateway credentials must exist.
 */
export function registerLocalAuth(app: FastifyInstance, config: Config, gatewayConfigured: boolean) {
  const expected = Buffer.from(`Bearer ${config.TEST_API_TOKEN}`)
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cache-Control", "no-store")
    if (req.url === "/health") return
    const supplied = Buffer.from(req.headers.authorization ?? "")
    const valid = supplied.length === expected.length && timingSafeEqual(supplied, expected)
    if (req.headers.origin || !valid) return reply.code(401).send({ error: "UNAUTHORIZED" })
    if (!gatewayConfigured) return reply.code(503).send({ error: "GATEWAY_CREDENTIALS_MISSING" })
  })
}
