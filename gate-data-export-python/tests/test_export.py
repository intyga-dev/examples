import base64
import copy
import hashlib
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from intyga_sdk import canonical_intent_payload, verification_code

from export_customers import export_customers


class FakeClient:
    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.public_key = base64.b64encode(self.key.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )).decode()
        self.did = "did:intyga:example-approver"
        self.trust = {
            "type": "intyga-trust-anchor", "v": 1, "epoch": 1,
            "approvers": [{"did": self.did, "publicKeys": [self.public_key]}],
        }
        self.tamper = None
        self.status = "APPROVED"
        self.consume_ok = True
        self.consume_count = 0
        self.requests = []
        self.after_request = None

    async def require_approval(self, display, *, action_type, params, target, timeout):
        self.requests.append(copy.deepcopy(params))
        params = copy.deepcopy(params)
        if self.tamper:
            params[self.tamper] = "changed-after-approval"
        nonce = str(uuid.uuid4())
        requester = {"did": "did:intyga:example-service", "attestation": None}
        requirement = {
            "requiredApprovals": 1, "requireHardwareKey": False, "allowedAaguids": [],
            "requesterCannotApprove": False, "signerClass": "human",
        }
        canonical = canonical_intent_payload(
            target, action_type, display, params, requester, requirement, nonce,
            (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
        )
        r, s = decode_dss_signature(self.key.sign(canonical.encode(), ec.ECDSA(hashes.SHA256())))
        signature = base64.b64encode(r.to_bytes(32, "big") + s.to_bytes(32, "big")).decode()
        if self.after_request:
            self.after_request()
        return {
            "nonce": nonce, "status": self.status,
            "receipt": {
                "target": target, "actionType": action_type, "actionDescription": display,
                "params": params, "requester": requester, "canonicalPayload": canonical,
                "signerDid": self.did, "signerPublicKey": self.public_key,
                "signature": signature, "sigAlg": "ES256", "verificationCode": verification_code(canonical),
            },
        }

    async def consume(self, nonce, action_type, *, params, target):
        self.consume_count += 1
        return {"ok": self.consume_ok}


class ExportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output = Path(self.directory.name) / "export.csv"
        self.client = FakeClient()

    async def export(self, **kwargs):
        return await export_customers(
            self.client, self.client.trust, target="data-export-example",
            region="EU", output=self.output, **kwargs,
        )

    async def test_writes_only_the_approved_snapshot_after_consumption(self):
        result = await self.export()
        snapshot = self.output.read_bytes()
        self.assertEqual(result["csvSha256"], hashlib.sha256(snapshot).hexdigest())
        self.assertEqual(result["rowCount"], 2)
        self.assertEqual(result["destination"], str(self.output))
        self.assertIn(b"example-001,EU,team", snapshot)
        self.assertNotIn(b"example-002", snapshot)
        self.assertEqual(self.client.consume_count, 1)

    async def test_changed_parameters_refuse_before_consumption_or_write(self):
        for field in ("csvSha256", "destination", "region", "rowCount", "requestId"):
            with self.subTest(field=field):
                self.client.tamper = field
                with self.assertRaisesRegex(RuntimeError, "RECEIPT_REFUSED"):
                    await self.export()
                self.assertFalse(self.output.exists())
        self.assertEqual(self.client.consume_count, 0)

    async def test_denied_or_expired_approval_never_creates_a_file(self):
        for status in ("DENIED", "EXPIRED", "PENDING"):
            self.client.status = status
            with self.assertRaisesRegex(RuntimeError, "NOT_APPROVED"):
                await self.export()
            self.assertFalse(self.output.exists())
        self.assertEqual(self.client.consume_count, 0)

    async def test_untrusted_signer_is_refused(self):
        self.client.trust["approvers"][0]["did"] = "did:intyga:another-person"
        with self.assertRaisesRegex(RuntimeError, "RECEIPT_REFUSED"):
            await self.export()
        self.assertFalse(self.output.exists())
        self.assertEqual(self.client.consume_count, 0)

    async def test_weaker_quorum_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "RECEIPT_REFUSED"):
            await self.export(required_approvals=2)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.client.consume_count, 0)

    async def test_unsuccessful_consumption_never_creates_a_file(self):
        for value in (False, None, "true", 1):
            self.client.consume_ok = value
            with self.assertRaisesRegex(RuntimeError, "CONSUMPTION_REFUSED"):
                await self.export()
            self.assertFalse(self.output.exists())

    async def test_existing_destination_refused_before_requesting(self):
        self.output.write_text("keep me")
        with self.assertRaises(ValueError):
            await self.export()
        self.assertEqual(self.output.read_text(), "keep me")
        self.assertEqual(self.client.requests, [])

    async def test_file_created_during_approval_is_not_overwritten(self):
        self.client.after_request = lambda: self.output.write_text("concurrent writer")
        with self.assertRaises(FileExistsError):
            await self.export()
        self.assertEqual(self.output.read_text(), "concurrent writer")


if __name__ == "__main__":
    unittest.main()
