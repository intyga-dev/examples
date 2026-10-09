"""Gate an export of synthetic customer rows on a verified, single-use approval."""

import argparse
import asyncio
import csv
import hashlib
import io
import json
import os
import sys
import uuid
from pathlib import Path

from intyga_sdk import (
    IntygaClient,
    parse_trust_anchor_file,
    trust_anchor_approvers,
    verify_approval_receipt,
)

# Fixed fictional data: no database or real customer information is accessed.
CUSTOMERS = (
    {"customer_id": "example-001", "region": "EU", "plan": "team"},
    {"customer_id": "example-002", "region": "US", "plan": "free"},
    {"customer_id": "example-003", "region": "EU", "plan": "free"},
)


async def export_customers(client, trust, *, target, region, output, required_approvals=1):
    if region not in {"EU", "US"} or not isinstance(target, str) or not target.strip():
        raise ValueError("Invalid export target or region")
    if type(required_approvals) is not int or required_approvals < 1:
        raise ValueError("Invalid approver quorum")
    destination = Path(output).resolve()
    if destination.suffix != ".csv" or destination.exists():
        raise ValueError("Output must be a new .csv file")

    # Freeze bytes before approval: never re-query a changing dataset after the human signs.
    rows = [row for row in CUSTOMERS if row["region"] == region]
    text = io.StringIO(newline="")
    writer = csv.DictWriter(text, fieldnames=["customer_id", "region", "plan"])
    writer.writeheader()
    writer.writerows(rows)
    snapshot = text.getvalue().encode("utf-8")
    params = {
        "region": region,
        "rowCount": len(rows),
        "destination": str(destination),
        "csvSha256": hashlib.sha256(snapshot).hexdigest(),
        "requestId": str(uuid.uuid4()),
    }
    action_type = "export_customers"
    approval = await client.require_approval(
        f"Export {len(rows)} synthetic {region} customer rows to {destination}",
        action_type=action_type, params=params, target=target, timeout=120,
    )
    if approval.get("status") != "APPROVED" or not approval.get("nonce") or not approval.get("receipt"):
        raise RuntimeError("NOT_APPROVED")
    nonce = approval["nonce"]
    webauthn = trust.get("webauthn") or {}
    checked = verify_approval_receipt(
        approval["receipt"],
        {
            "target": target, "actionType": action_type, "params": params, "nonce": nonce,
            "approvers": trust_anchor_approvers(trust),
            "requirement": {"requiredApprovals": required_approvals},
        },
        expected_origin=webauthn.get("origin"), expected_rp_id=webauthn.get("rpId"),
    )
    if not checked["ok"]:
        raise RuntimeError("RECEIPT_REFUSED")
    consumed = await client.consume(nonce, action_type, params=params, target=target)
    if consumed.get("ok") is not True:
        raise RuntimeError("CONSUMPTION_REFUSED")

    # Exclusive creation prevents overwriting a file created while the human was deciding.
    with destination.open("xb") as file:
        file.write(snapshot)
    return {"status": "SYNTHETIC_DATA_EXPORTED", **params}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", choices=["EU", "US"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    trust = parse_trust_anchor_file(
        Path(os.environ.get("INTYGA_TRUST_ANCHOR_FILE", "trust-anchor.json")).read_text(encoding="utf-8")
    )
    target = os.environ.get("INTYGA_TARGET", "data-export-example")
    client = IntygaClient(
        gateway_url=os.environ["INTYGA_GATEWAY_URL"],
        client_id=os.environ["INTYGA_CLIENT_ID"],
        client_secret=os.environ["INTYGA_CLIENT_SECRET"],
        target=target,
    )
    print("Waiting for a passkey approval in your INTYGA console.", file=sys.stderr)
    result = await export_customers(
        client, trust, target=target, region=args.region, output=args.output,
        required_approvals=int(os.environ.get("INTYGA_REQUIRED_APPROVALS", "1")),
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        # Raw SDK/network exceptions may contain request details; keep console output fixed.
        print("Export failed. Check configuration, approval and the output path.", file=sys.stderr)
        sys.exit(1)
