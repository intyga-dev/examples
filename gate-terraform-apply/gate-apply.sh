#!/usr/bin/env bash
#
# Gate `terraform apply` on a human signature bound to the exact plan.
#
# The load-bearing detail is that we apply a SAVED PLAN FILE, never a bare `terraform apply`. A bare
# apply re-plans at execution time, so the human approves one thing and Terraform executes whatever
# the world looks like a moment later — approve A, execute B. `terraform plan -out` freezes the
# decision; `terraform apply tfplan` runs that frozen decision and refuses if state has moved under
# it. Hashing the plan file is what ties the signature to it.
set -euo pipefail

WORKSPACE="${TF_WORKSPACE:-default}"
TARGET="${INTYGA_TARGET:-prod-eu-1}"
PLAN="${PLAN_FILE:-tfplan}"

: "${INTYGA_GATEWAY_URL:?set INTYGA_GATEWAY_URL}"
: "${INTYGA_CLIENT_ID:?set INTYGA_CLIENT_ID (a SERVICE identity — it requests, a human approves)}"
: "${INTYGA_CLIENT_SECRET:?set INTYGA_CLIENT_SECRET}"
# Approver keys are REQUIRED and come from your side. A receipt checked against the key inside
# itself proves nothing, so the CLI has no default for this.
: "${INTYGA_APPROVER_KEYS:?set INTYGA_APPROVER_KEYS (comma-separated public keys you trust)}"
# Passkey receipts (the normal flow) also need the WebAuthn expectations — the origin and
# RP ID of the approval console the human signs in. The verifier fails closed without them.
: "${INTYGA_WEBAUTHN_ORIGIN:?set INTYGA_WEBAUTHN_ORIGIN (the approval console origin)}"
: "${INTYGA_WEBAUTHN_RP_ID:?set INTYGA_WEBAUTHN_RP_ID (its relying-party ID)}"

terraform init -input=false >/dev/null

echo "==> Planning"
terraform plan -input=false -out="$PLAN"

# The hash of the bytes that will actually execute. Recomputed rather than remembered — see the CI
# workflow, where the applying job hashes the artifact it received instead of trusting the planner.
PLAN_HASH="$(sha256sum "$PLAN" | cut -d' ' -f1)"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

echo "==> Plan hash ${PLAN_HASH}"
echo "==> Requesting human approval"

# Show the human what changes, not just a hash — the hash binds it, the summary lets them decide.
terraform show -no-color "$PLAN" | head -60

PARAMS="$(jq -cn \
  --arg workspace "$WORKSPACE" \
  --arg planHash "$PLAN_HASH" \
  --arg commit "$COMMIT" \
  '{workspace: $workspace, planHash: $planHash, commit: $commit}')"

# --consume redeems the approval single-use, so the same signature cannot authorise a second apply.
# A non-zero exit here means denied, expired, or a receipt that failed to verify — in every case we
# must not apply, which `set -e` handles.
npx --yes @intyga/sdk authorize "Terraform apply — ${WORKSPACE} (${PLAN_HASH:0:12})" \
  --gateway "$INTYGA_GATEWAY_URL" \
  --target "$TARGET" \
  --type terraform_apply \
  --params "$PARAMS" \
  --consume

echo "==> Approved. Applying the exact plan that was signed for."

# `terraform apply tfplan` — not `terraform apply`. If the second word ever disappears from this
# line, the gate above becomes decorative.
terraform apply -input=false "$PLAN"
