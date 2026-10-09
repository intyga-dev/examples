import { createApp } from "./app.js"
import { loadConfig, loadTrust } from "./config.js"

try {
  const config = loadConfig()
  const app = createApp(config, loadTrust(config), console.log)
  await app.listen({ host: "127.0.0.1", port: config.PORT })
  console.log(`INTYGA approval gate example: http://127.0.0.1:${config.PORT}`)
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void app.close()
    })
  }
} catch {
  console.error("Startup failed. Check .env, the trust anchor and that the port is free.")
  process.exitCode = 1
}
