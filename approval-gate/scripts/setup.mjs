import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"

const template = readFileSync(new URL("../.env.example", import.meta.url), "utf8")
try {
  writeFileSync(
    new URL("../.env", import.meta.url),
    template.replace("TEST_API_TOKEN=\n", `TEST_API_TOKEN=${randomBytes(32).toString("hex")}\n`),
    { flag: "wx", mode: 0o600 },
  )
  console.log(".env created. Fill in the INTYGA credentials to run live.")
} catch (error) {
  if (error.code !== "EEXIST") throw error
  console.log(".env already exists and is kept.")
}
