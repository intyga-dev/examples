# Approve a CSV data export in Python

An async Python example of the **INTYGA** approval gate for a backend data operation. It selects
from three fictional customer rows, freezes the CSV bytes, and requests approval binding the
region, row count, destination path and SHA-256 digest. It verifies the receipt locally and
consumes the approval before writing a new file. It never reads a real customer database.

## Run

Requires Python 3.10+. From this directory:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v

export INTYGA_GATEWAY_URL=http://localhost:8787
export INTYGA_CLIENT_ID=your-client-id
read -rs -p 'API secret: ' INTYGA_CLIENT_SECRET; echo
export INTYGA_CLIENT_SECRET
python export_customers.py --region EU --output export.csv
```

Use a human or SERVICE API key. Configure an approval rule for target `data-export-example`,
action `export_customers`. Export a reviewed **online trust anchor** from the console's Approval
rules page to `trust-anchor.json`; include the console's WebAuthn origin and RP ID for passkeys.
Never populate trusted approvers from an incoming receipt.

Optional environment variables: `INTYGA_TARGET`, `INTYGA_TRUST_ANCHOR_FILE`, and
`INTYGA_REQUIRED_APPROVALS` (default 1). The script reads environment variables directly; it does
not load `.env` files. Only `EU` and `US` regions are accepted, and an existing output file is
refused. The wait is bounded to 120 seconds.

## Adapting it

Read [export_customers.py](export_customers.py). Keep the dataset snapshot and output destination
fixed across approval and execution. In a real export worker, enforce caller access to the dataset
and destination before starting this flow, use an immutable snapshot with an access-controlled
destination, and record the execution outcome in your own audit trail.

Consumption and file creation are separate operations. If writing fails after consumption, the
approval stays consumed; this example has no retry/reconciliation service and can leave a partial
file on an I/O failure. A production worker needs durable job state and an atomic output commit.
The snapshot is in memory, so this is intended for small datasets.

Tests use fresh ES256 signatures and the real verifier. They require neither gateway access nor
credentials and cover changed exports, refused approvals, untrusted signers and consumption failure.
