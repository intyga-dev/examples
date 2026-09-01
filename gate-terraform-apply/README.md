# Gate a `terraform apply` on a human signature

Terraform is the scenario Intyga's own site leads with, so this is the example that has to be right.

The naive version — ask for approval, then run `terraform apply` — **does not work**, and it is worth
being precise about why before you copy anything below.

## The problem: `terraform apply` re-plans

```sh
# BROKEN. Do not do this.
intyga authorize "Apply prod" --target prod-eu-1 --type terraform_apply --consume
terraform apply -auto-approve
```

A bare `terraform apply` computes a **fresh plan** at the moment it runs. Between the approval and
the apply, state can drift, a data source can resolve differently, a module version can float, or a
teammate can apply something else. The human approved a plan they saw; Terraform executes a plan
nobody saw. The signature is real and it is bound to nothing that survives.

This is the same failure the product exists to prevent, one layer up: *approve A, execute B*.

## The fix: sign the plan file, apply that exact file

`terraform plan -out=tfplan` writes a binary plan — a frozen, executable decision. `terraform apply
tfplan` runs **that** plan and refuses if the state it was computed against has moved.

So hash the plan file, bind the hash into the approval, and apply only the file that was signed for:

```
terraform plan -out=tfplan
        │
        ├─ sha256(tfplan) ──────────────► approval params
        │                                  { workspace, planHash, commit, account }
        │                                          │
        │                                   human signs those exact bytes
        │                                          │
        └─ terraform apply tfplan ◄────────── only after the receipt verifies
```

`planHash` is what makes the signature mean something specific. If anything about the plan changes,
the hash changes, the receipt no longer verifies against your recomputed parameters, and the script
refuses to apply.

## Run it

```sh
export INTYGA_GATEWAY_URL=https://api.intyga.com
export INTYGA_CLIENT_ID=...        # a SERVICE identity — it requests, a human approves
export INTYGA_CLIENT_SECRET=...
export INTYGA_APPROVER_KEYS=...    # comma-separated public keys YOU trust
export INTYGA_WEBAUTHN_ORIGIN=...  # the approval console's origin — REQUIRED for passkey receipts
export INTYGA_WEBAUTHN_RP_ID=...   # its relying-party ID; the verifier fails closed without these

./gate-apply.sh
```

`main.tf` writes a local file and needs no cloud credentials, so you can watch the whole ceremony
end to end before pointing it at anything real.

To see the binding actually hold, approve the request and then edit `main.tf` before the script
reaches the apply step. The plan hash no longer matches and it refuses.

## In CI

`terraform-apply.yml` is the same flow as a GitHub Actions workflow, split so a headless runner never
blocks on a browser: `authorize --no-wait` → `notify` → `await --consume`. The plan file is passed
between jobs as an artifact, and the applying job **recomputes the hash from the bytes it received**
rather than trusting the hash the planning job reported.

That last point is the one people skip. A planning job that has been compromised can report any hash
it likes; recomputing it in the job that holds the credentials is what makes the gate an
authorization boundary rather than a comment. Same reasoning as
[the package-publishing architecture](https://intyga.com/use-cases/package-publishing).

## What this does not do

It proves a named person approved this exact plan. It does not review the plan — a destructive change
that a human reads and approves still applies. Keep `terraform plan` review, state locking, and
whatever policy checking you already run; this composes with them.
