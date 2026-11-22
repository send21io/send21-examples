"""Offline tests for payment_send21: the framework-free core plus file checks. No Odoo needed."""
import ast
import importlib.util
import json
import pathlib
import unittest
import xml.etree.ElementTree as ET

MODULE = pathlib.Path(__file__).resolve().parents[1] / "payment_send21"
spec = importlib.util.spec_from_file_location("send21_core", MODULE / "send21_core.py")
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)

SECRET = "whsec_test_only_not_a_real_secret"
TX = {"reference": "S00042-1", "amount": 46.0, "currency": "EUR", "provider_reference": "pr_1", "state": "pending"}
CONFIRMED = {"orderId": "odoo-S00042-1", "paymentRequestId": "pr_1", "fiatCurrency": "EUR", "fiatAmount": 46,
             "txId": "5KqZ9bQ...", "sentAmount": "50.000000", "sentCurrency": "USDC", "network": "Solana"}


class CoreTest(unittest.TestCase):
    def test_request_body(self):
        options = core.parse_options('[{"currency":"Btc","network":"Mainnet","address":"you@wallet.com","method":"Lightning"}]')
        body, key = core.build_payment_request("S00042-1", 46.004, "eur", options, expiry_hours=1000)
        self.assertEqual(key, "odoo-S00042-1-46.00")
        self.assertEqual(body["orderId"], "odoo-S00042-1")
        self.assertEqual(body["fiatCurrency"], "EUR")
        self.assertEqual(body["fiatAmount"], 46.0)
        self.assertEqual(body["expiryHours"], 720)
        self.assertTrue(body["reuseOpenForOrder"])
        self.assertEqual(body["declineNote"], core.DEFAULT_DECLINE_NOTE)
        self.assertEqual(core.reference_from_order_id("odoo-S00042-1"), "S00042-1")
        self.assertIsNone(core.reference_from_order_id("shop-1"))
        self.assertEqual(len(core.clean_decline_note("q" * 300)), 200)
        with self.assertRaises(ValueError):
            core.parse_options('[{"currency":"Usdc","network":"Tron","address":"T1"}]')

    def test_signature(self):
        raw = json.dumps({"event": "draft.confirmed", "data": CONFIRMED}).encode()
        h = core.sign_v2(raw, "dlv_1", 1_790_000_000, SECRET)
        self.assertTrue(core.verify_signature_v2(raw, h, "dlv_1", SECRET, 1_790_000_300))
        self.assertFalse(core.verify_signature_v2(raw, h, "dlv_1", SECRET, 1_790_000_301))
        self.assertFalse(core.verify_signature_v2(raw, h, "dlv_9", SECRET, 1_790_000_000))
        self.assertFalse(core.verify_signature_v2(raw + b"x", h, "dlv_1", SECRET, 1_790_000_000))
        self.assertFalse(core.verify_signature_v2(raw, h, "dlv_1", None, 1_790_000_000))

    def test_decisions(self):
        self.assertEqual(core.decide("draft.confirmed", CONFIRMED, TX)["action"], "done")
        self.assertEqual(core.decide("draft.confirmed", CONFIRMED, {**TX, "state": "done"})["action"], "ignore")
        self.assertEqual(core.decide("draft.confirmed", {**CONFIRMED, "fiatAmount": 45}, TX)["action"], "review")
        self.assertEqual(core.decide("draft.confirmed", {**CONFIRMED, "paymentRequestId": "pr_2"}, TX)["action"], "ignore")
        self.assertEqual(core.decide("draft.amount_mismatch", {"orderId": "odoo-S00042-1"}, TX)["action"], "review")
        self.assertEqual(core.decide("payment_request.expired", {"orderId": "odoo-S00042-1"}, TX)["action"], "cancel")
        self.assertEqual(core.decide("draft.confirmed", {**CONFIRMED, "orderId": "odoo-OTHER"}, TX)["action"], "ignore")


class ModuleFilesTest(unittest.TestCase):
    def test_manifest_and_data_files(self):
        manifest = ast.literal_eval((MODULE / "__manifest__.py").read_text())
        self.assertEqual(manifest["depends"], ["payment"])
        for path in manifest["data"]:
            self.assertTrue((MODULE / path).exists(), path)
            if path.endswith(".xml"):
                ET.parse(MODULE / path)

    def test_python_files_compile(self):
        for path in MODULE.rglob("*.py"):
            compile(path.read_text(), str(path), "exec")


if __name__ == "__main__":
    unittest.main()
