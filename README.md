# Examples

Runnable integrations. Each directory is self-contained with its own README — copy the one closest
to your situation and change the target, action type and parameters.

## Reference application

Start with **[`approval-gate`](approval-gate/)** for a complete TypeScript application: a Fastify
API, an MCP agent, and tests of the approval → local verification → single-use consumption →
execution flow. It simulates money transfers and demonstrates both an API requesting approval
and an API verifying a receipt supplied by an agent. Optional MCP wrapper and proxy examples
are included. No real payments are made.

## Focused code examples

| Example | Language / platform | What it gates |
| :--- | :--- | :--- |
| [`gate-artifact-deploy`](gate-artifact-deploy/) | TypeScript CLI | A simulated release bound to the **artifact SHA-256 digest** and destination environment |
| [`gate-data-export-python`](gate-data-export-python/) | Python async worker | A CSV export of fictional rows, bound to the **snapshot digest**, region and destination |
| [`gate-terraform-apply`](gate-terraform-apply/) | Terraform + shell + GitHub Actions | A `terraform apply`, bound to the **plan file hash** so the apply cannot drift from what was approved |
| [`ci-cd-github-action`](ci-cd-github-action/) | GitHub Actions | Any workflow step, with no application code changes |
| [`gate-ci-pipelines`](gate-ci-pipelines/) | GitLab CI · Jenkins · Azure Pipelines | The same deploy gate on the CI systems with no Action |
| [`gate-prod-delete`](gate-prod-delete/) | Node.js | A destructive database operation |
| [`gate-prod-delete-java`](gate-prod-delete-java/) | Java | The same, for a JVM service |
| [`gate-spring-boot-endpoint`](gate-spring-boot-endpoint/) | Spring Boot | A privileged HTTP endpoint |
| [`gate-quarkus-deploy`](gate-quarkus-deploy/) | Quarkus | A deploy endpoint |
| [`gate-langchain4j-tool`](gate-langchain4j-tool/) | LangChain4j | An AI agent tool call before it executes |

## The approval pattern

```
1. Build the exact parameters you are about to execute.
2. Request a human approval and wait for the signed result.
3. Re-verify the receipt LOCALLY against approver keys you already trust.
4. Consume the approval for that exact instruction, refusing unsuccessful consumption.
5. Execute the approved instruction.
```

Step 3 is the one that matters and the one most likely to be dropped when adapting an example. The
receipt is checked in your process, against parameters you derived and keys you already trusted —
never against anything the response says about itself. `approvers` is a required argument with no
default for exactly this reason: a receipt checked against the key inside itself proves nothing.

## Two mistakes these examples are written to prevent

**Approving a description instead of an instruction.** Bind the values that will actually execute —
the IBAN, the plan hash, the artifact digest — not a sentence about them. If a parameter can change
between approval and execution without changing the signature, it was never really gated.

**Re-deriving the work after approval.** `terraform apply` without a saved plan file re-plans;
a publish step that rebuilds instead of shipping the reviewed artifact rebuilds. Approve A, execute
A — see [`gate-terraform-apply`](gate-terraform-apply/) for the worked version of this.

Consumption prevents approval replay. It is separate from executing your business action: real
integrations need durable execution records, idempotency and reconciliation to handle a crash
between those steps. Approval records do not prove the business operation completed.

## Running and contributing

These examples are maintained in INTYGA core and exported to the public examples repository.
They use published packages and are independent of the core pnpm workspace. For Node projects, run
`pnpm install --ignore-workspace` inside the example; this creates a local lockfile. The checked-in
example locks are omitted while the coordinated 2.0.0 packages are not yet published, because their
tarballs cannot be represented honestly in a registry lock. Regenerate and check in those locks
after publication. Follow each README for credentials, trust-anchor setup and execution.

The **Runnable examples** CI job builds the public export, packs the candidate `@intyga/sdk`,
`@intyga/verify`, `@intyga/mcp-sdk` and `@intyga/mcp-proxy` from the checkout, then installs those
artifacts into the temporary exported Node examples through test-only dependency overrides. It also
builds and installs a candidate Python SDK wheel into the exported Python example. The job audits
production dependencies, typechecks, builds and tests `approval-gate` and `gate-artifact-deploy`, and
runs the Python export tests. The examples keep their semver dependency ranges; candidate
artifacts are used only in CI's temporary copy.
This lets changes to receipt verification, including tenant binding, be tested before publication.
The tests use locally generated signatures and require no gateway or credentials. Other recipes
retain the manual verification described in their READMEs.

To add an example, create a descriptive directory with a README, published dependency versions,
sample configuration and a harmless default action. Explain the trust assumptions and production
limitations. Add executable tests for approval refusal, changed parameters and failed consumption,
and include the project in the Runnable examples CI job. Keep `.env`, trust anchors, private keys
and generated output out of source control; the public export filters these local files too.

## Related

- [`docs/quickstart.md`](../docs/quickstart.md) — gate one call, end to end
- [`docs/API.md`](../docs/API.md) — the REST surface these call
- [`docs/MCP.md`](../docs/MCP.md) — the agent path
