# Gate a deploy in GitLab CI, Jenkins or Azure Pipelines

The same three-step ceremony as the [GitHub Action](../ci-cd-github-action/), for the CI systems that
do not have one. No application code changes — you wrap the pipeline, not the app.

| File | Platform |
| :--- | :--- |
| [`.gitlab-ci.yml`](.gitlab-ci.yml) | GitLab CI |
| [`Jenkinsfile`](Jenkinsfile) | Jenkins (declarative) |
| [`azure-pipelines.yml`](azure-pipelines.yml) | Azure Pipelines |

## The shape

```
build     produce the artefact. No deploy credentials in this stage.
   │
approve   intyga authorize --no-wait   -> nonce + approval URL, returns immediately
          intyga notify                -> Slack/Teams button, link only, never parameters
   │
deploy    intyga await --consume       -> blocks until signed, verifies, redeems single-use
          <your deploy command>        -> only reachable if the above exited 0
```

Splitting approve from deploy is the point. The stage holding deploy credentials is the stage that
verifies the receipt, so a compromised build stage can request an approval but cannot obtain one and
cannot reach the credentials.

## The one detail that breaks these if you get it wrong

`intyga authorize --no-wait` writes `nonce` and `approval_url` into `$GITHUB_OUTPUT` **only when that
variable is set** — that is, only on GitHub Actions. Everywhere else it is a no-op.

On every other platform the machine-readable result is the **last line of stdout**, a JSON object:

```json
{"nonce":"…","approvalUrl":"https://…/approve?nonce=…"}
```

Note `approvalUrl` — camelCase in the stdout JSON, `approval_url` in the GitHub output file. Copying a
GitHub example onto GitLab and reading `approval_url` yields an empty string, and an empty nonce
makes `await` fail in a way that looks like a gateway problem rather than a parsing bug.

A human-readable banner is printed before that line, so take the last line specifically:

```sh
OUT=$(npx --yes @intyga/sdk authorize "..." ... --no-wait --no-open | tail -n1)
NONCE=$(printf '%s' "$OUT" | jq -r .nonce)
URL=$(printf '%s' "$OUT" | jq -r .approvalUrl)
```

## Required configuration

Set these as protected/masked CI variables, scoped to the deploying environment where the platform
supports it:

| Variable | Notes |
| :--- | :--- |
| `INTYGA_GATEWAY_URL` | |
| `INTYGA_WEB_URL` | Where the approval link points |
| `INTYGA_CLIENT_ID` / `INTYGA_CLIENT_SECRET` | A **SERVICE** identity — the pipeline requests, a human approves. Separation of duties is a property of the key, not of a job name. |
| `INTYGA_APPROVER_KEYS` | Comma-separated public keys **you** trust. Required, no default: a receipt checked against the key inside itself proves nothing. |
| `INTYGA_SLACK_WEBHOOK` | Optional |

Give the approval variables to the whole pipeline if you like — they only permit *requesting*. Deploy
credentials must be scoped to the deploy stage alone; that is the boundary doing the work.

## Adapting these

Change `--target` to the environment being acted on and `--params` to the values that will actually
execute. Bind what matters — a commit SHA, a plan hash, an artifact digest — not a sentence about it.
If a parameter can change between approval and execution without changing the signature, it was never
really gated. See [`gate-terraform-apply`](../gate-terraform-apply/) for the worked version.
