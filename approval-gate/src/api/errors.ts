import type { FastifyInstance } from "fastify"
import { z } from "zod"

/** Maps any exception to a safe response. Upstream bodies and secrets never reach the caller. */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, _req, reply) => {
    let status = 502
    if (error instanceof z.ZodError) {
      status = 400
    } else if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      status = error.statusCode
    }
    reply.code(status).send({ error: status < 500 ? "INVALID_REQUEST" : "GATEWAY_REQUEST_FAILED" })
  })
}
