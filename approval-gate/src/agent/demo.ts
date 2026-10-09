import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

// A scripted agent that shows both outcomes against the running transfer API (pnpm start):
//   1. an honest transfer: approved, receipt verified, money moves
//   2. a tampered transfer: the amount is changed after approval, verification fails
// You approve each request in the INTYGA console. The backend logs SUCCEEDED / REFUSED.

const transfer = { to: "SE4550000000058398257466", amount: 250, currency: "EUR" }
const CALL_TIMEOUT_MS = 180_000

const client = new Client({ name: "demo-agent", version: "1" })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--env-file-if-exists=.env", "--import", "tsx", "src/agent/stdio.ts"],
  env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<
    string,
    string
  >,
  stderr: "pipe",
})
transport.stderr?.on("data", (chunk) => console.log(`   [agent] ${String(chunk).trim()}`))

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })
  const [content] = result.content as { text: string }[]
  return { isError: Boolean(result.isError), data: JSON.parse(content?.text ?? "null") }
}

async function askForApproval(label: string) {
  console.log(
    `\n${label}\n   Asking for approval of ${transfer.amount} ${transfer.currency}, waiting for you...`,
  )
  const { isError, data } = await call("request_transfer_approval", transfer)
  if (isError) throw new Error(`No approval: ${JSON.stringify(data)}`)
  console.log("   Approved. The agent now holds the signed receipt.")
  return data.approval
}

let failed = false
const expect = (label: string, ok: boolean, detail: unknown) => {
  console.log(`   ${ok ? "PASS" : "FAIL"}: ${label}\n   backend answered: ${JSON.stringify(detail)}`)
  if (!ok) failed = true
}

try {
  await client.connect(transport)

  const honest = await askForApproval("1. Honest transfer")
  const done = await call("transfer_money", { ...transfer, approval: honest })
  expect("backend verified the receipt and executed the transfer", !done.isError && done.data.ok, {
    ok: done.data.ok,
    status: done.data.transfer?.status,
  })

  const approved = await askForApproval("2. Tampered transfer")
  const bigger = { ...transfer, amount: 25_000 }
  console.log(
    `   Agent now asks the backend to move ${bigger.amount} ${bigger.currency} with that receipt...`,
  )
  const refused = await call("transfer_money", { ...bigger, approval: approved })
  expect(
    "backend refused because verification failed",
    refused.isError && refused.data.error === "RECEIPT_REFUSED",
    refused.data,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  failed = true
} finally {
  await client.close()
}
process.exitCode = failed ? 1 : 0
