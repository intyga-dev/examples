# Example: gate a LangChain4j agent tool

A LangChain4j `@Tool` method (`wire_transfer`) whose first statement escalates to an out-of-band
human approval — the Java counterpart of the Python SDK's `require_human_approval` guard for
LangChain/CrewAI. There is no per-framework adapter, deliberately: every agent framework reduces a
tool to a method call, so the gate is one line at the top of the method.

## Run

```bash
# One-time, from the monorepo (neither package is on Maven Central yet):
mvn -f ../../packages/verify-java/pom.xml install
mvn -f ../../packages/sdk-java/pom.xml install

INTYGA_GATEWAY_URL=http://localhost:8787 \
INTYGA_CLIENT_ID=<your-api-key-client-id> \
INTYGA_CLIENT_SECRET=<your-api-key-secret> \
INTYGA_APPROVER_KEYS=<base64-approver-public-key>[,<more>] \
mvn -q compile exec:java
```

`INTYGA_APPROVER_KEYS` is the key set **this runtime** trusts, resolved from its own key
management — never the one carried inside the receipt, so there is deliberately no default.

Without `OPENAI_API_KEY` the example invokes the tool method directly (the approval ceremony is
identical); with it, a real agent decides to call the tool:

```bash
OPENAI_API_KEY=sk-... mvn -q compile exec:java -Dexec.args="Wire 5000 EUR to acme-gmbh"
```

Either way the tool **blocks** until a human approves with a passkey or security key. The params
the approver reads and signs are exactly the arguments the model chose — a hallucinated amount or a
prompt-injected recipient is what the human sees, which is the point.

After approval the tool verifies the receipt **offline**, in-process, against the keys it resolved
itself — then redeems it and reports which humans signed. A receipt is evidence, and evidence you do
not check is not evidence.

Try the failure paths: **deny** the approval and `ApprovalRefusedException` propagates out of the
tool method — the framework cannot mistake "the human said no" for a tool result, and nothing is
wired. An `EXPIRED` timeout behaves the same way. Point `INTYGA_APPROVER_KEYS` at a key that did not
sign and the transfer is refused even though the gateway approved it.
