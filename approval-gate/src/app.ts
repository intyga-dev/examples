import { IntygaClient, type TrustAnchorFile } from "@intyga/sdk"
import Fastify from "fastify"
import { registerLocalAuth } from "./api/auth.js"
import { registerErrorHandler } from "./api/errors.js"
import { registerRoutes } from "./api/routes.js"
import type { Config } from "./config.js"

/** Builds the REST approval gate. See src/api/ for the individual pieces. */
export function createApp(
  config: Config,
  trust?: TrustAnchorFile,
  log: (message: string) => void = () => {},
) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 })
  const client = new IntygaClient({
    gatewayUrl: config.INTYGA_GATEWAY_URL,
    clientId: config.INTYGA_CLIENT_ID,
    clientSecret: config.INTYGA_CLIENT_SECRET,
  })
  const gatewayConfigured = Boolean(config.INTYGA_CLIENT_ID && config.INTYGA_CLIENT_SECRET)

  registerLocalAuth(app, config, gatewayConfigured)
  registerErrorHandler(app)
  registerRoutes(app, { config, client, trust, gatewayConfigured, log })
  return app
}
