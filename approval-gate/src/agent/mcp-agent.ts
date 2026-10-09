import { randomUUID } from "node:crypto"
import type { IntygaClient } from "@intyga/sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Config } from "../config.js"
import {
  createTransferAction,
  describeTransfer,
  transferSchema,
  transferWithReceiptSchema,
} from "../contracts/transfer.js"

/** Sends a request to the final endpoint. Injected so tests can call the app directly. */
export type CallTransferApi = (path: string, body: unknown) => Promise<{ status: number; body: unknown }>

export function httpTransferApi(baseUrl: string, token: string): CallTransferApi {
  return async (path, body) => {
    const response = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }
}

const jsonResult = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
})

/**
 * An MCP server for an AI agent that may move money only with a human's approval.
 *   1. request_transfer_approval - asks the human and waits; returns the signed receipt.
 *   2. transfer_money            - sends the transfer and the receipt to the final endpoint,
 *                                  which verifies the receipt on its own before moving anything.
 * The agent never verifies or trusts the receipt itself, it only carries it.
 */
export function createAgentServer(deps: {
  config: Config
  client: IntygaClient
  callApi: CallTransferApi
  announce?: (message: string) => void
}) {
  const { config, client, callApi, announce = () => {} } = deps
  const server = new McpServer({ name: "intyga-agent-example", version: "0.1.0" })

  server.registerTool(
    "request_transfer_approval",
    {
      description:
        "Ask a human to approve a money transfer and wait for the decision. " +
        "Returns an approval (nonce, approvalRequestId, receipt) to pass to transfer_money.",
      inputSchema: transferSchema.shape,
    },
    async (transfer) => {
      const approvalRequestId = randomUUID()
      const action = createTransferAction(config.INTYGA_TARGET, transfer, approvalRequestId)
      announce(`Waiting for approval in INTYGA: ${config.INTYGA_WEB_URL}`)
      const { status, nonce, receipt } = await client.requireApproval(
        `Transfer ${describeTransfer(transfer)}`,
        {
          ...action,
          timeoutMs: config.INTYGA_WAIT_TIMEOUT_MS,
          intervalMs: config.INTYGA_POLL_INTERVAL_MS,
        },
      )
      if (status !== "APPROVED" || !nonce || !receipt) {
        return jsonResult({ error: "NOT_APPROVED", status }, true)
      }
      return jsonResult({ approval: { nonce, approvalRequestId, receipt } })
    },
  )

  server.registerTool(
    "transfer_money",
    {
      description:
        "Transfer money. Requires the approval returned by request_transfer_approval for these exact values.",
      inputSchema: transferWithReceiptSchema.shape,
    },
    async (input) => {
      const response = await callApi("/transfer-money/with-receipt", input)
      return jsonResult(response.body, response.status >= 400)
    },
  )
  return server
}
