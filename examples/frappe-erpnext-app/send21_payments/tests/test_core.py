import json
import pathlib
import unittest

from send21_payments.send21_core import (
    DEFAULT_DECLINE_NOTE,
    build_payment_request,
    clean_decline_note,
    decide,
    order_id_for,
    parse_options,
    pay_link,
    sign_v2,
    verify_signature_v2,
)

SECRET = "whsec_test_only_not_a_real_secret"
FIXTURE = pathlib.Path(__file__).with_name("draft_confirmed.json").read_bytes()
LINK = {"order_id": "erpnext-sinv-ACC-SINV-2026-00042", "payment_request_id": "8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b",
        "amount": 46.0, "currency": "EUR", "status": "Open"}


class PaymentRequestTest(unittest.TestCase):
    def test_body(self):
        options = parse_options('[{"currency":"Usdc","network":"Base","address":"0xReceiver"},'
                                '{"currency":"Btc","network":"Mainnet","address":"you@wallet.com","method":"Lightning"}]')
        body, key = build_payment_request(order_id=order_id_for("Sales Invoice", "ACC-SINV-2026-00042"), memo="Invoice ACC-SINV-2026-00042",
                                          amount=46.004, currency="eur", options=options, expiry_hours=0)
        self.assertEqual(key, "erpnext-sinv-ACC-SINV-2026-00042-46.00")
        self.assertEqual(body["fiatAmount"], 46.0)
        self.assertEqual(body["fiatCurrency"], "EUR")
        self.assertEqual(body["orderId"], "erpnext-sinv-ACC-SINV-2026-00042")
        self.assertTrue(body["reuseOpenForOrder"])
        self.assertEqual(body["expiryHours"], 24)
        self.assertEqual(body["declineNote"], DEFAULT_DECLINE_NOTE)
        self.assertEqual(body["options"][1]["method"], "Lightning")
        with self.assertRaises(ValueError):
            build_payment_request(order_id="x", memo="m", amount=0, currency="EUR", options=options)

    def test_decline_note(self):
        self.assertEqual(clean_decline_note("<p>Late   fee</p>"), "Late fee")
        self.assertEqual(len(clean_decline_note("z" * 500)), 200)

    def test_options(self):
        for bad in ("[]", '[{"currency":"Doge","network":"Base","address":"0x1"}]', '[{"currency":"Usdc","network":"Base"}]'):
            with self.assertRaises(ValueError):
                parse_options(bad)

    def test_pay_link(self):
        self.assertEqual(pay_link("/pay/abc"), "https://send21.io/pay/abc")
        with self.assertRaises(ValueError):
            pay_link(None)


class SignatureTest(unittest.TestCase):
    def test_v2_window_and_binding(self):
        now = 1_790_000_000
        header = sign_v2(FIXTURE, "dlv_1", now, SECRET)
        self.assertTrue(verify_signature_v2(FIXTURE, header, "dlv_1", SECRET, now + 300))
        self.assertFalse(verify_signature_v2(FIXTURE, header, "dlv_1", SECRET, now + 301))
        self.assertFalse(verify_signature_v2(FIXTURE, header, "dlv_2", SECRET, now))
        self.assertFalse(verify_signature_v2(FIXTURE + b" ", header, "dlv_1", SECRET, now))
        self.assertFalse(verify_signature_v2(FIXTURE, header, "dlv_1", "", now))
        self.assertFalse(verify_signature_v2(FIXTURE, None, "dlv_1", SECRET, now))


class DecideTest(unittest.TestCase):
    def setUp(self):
        payload = json.loads(FIXTURE)
        self.event, self.data = payload["event"], payload["data"]

    def test_confirmed_pays(self):
        self.assertEqual(decide(self.event, self.data, LINK)["action"], "pay")

    def test_paid_link_is_not_paid_again(self):
        self.assertEqual(decide(self.event, self.data, {**LINK, "status": "Paid"})["action"], "ignore")

    def test_other_amount_or_link(self):
        self.assertEqual(decide(self.event, {**self.data, "fiatAmount": 40}, LINK)["action"], "review")
        self.assertEqual(decide(self.event, {**self.data, "fiatCurrency": "USD"}, LINK)["action"], "review")
        self.assertEqual(decide(self.event, {**self.data, "paymentRequestId": "other"}, LINK)["action"], "ignore")
        self.assertEqual(decide(self.event, {**self.data, "orderId": "erpnext-sinv-OTHER"}, LINK)["action"], "ignore")

    def test_mismatch_and_expiry(self):
        base = {"orderId": LINK["order_id"]}
        self.assertEqual(decide("draft.amount_mismatch", base, LINK)["action"], "review")
        self.assertEqual(decide("payment_request.expired", {**base, "opened": True}, LINK)["action"], "expire")
        self.assertEqual(decide("payment_request.expired", base, {**LINK, "status": "Paid"})["action"], "ignore")


class AppLayoutTest(unittest.TestCase):
    def test_doctypes_are_valid_json_in_the_module(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        for name in ("send21_settings", "send21_pay_link", "send21_webhook_delivery"):
            doc = json.loads((root / "send21_payments" / "doctype" / name / f"{name}.json").read_text())
            self.assertEqual(doc["module"], "Send21 Payments")
            self.assertEqual(doc["field_order"], [f["fieldname"] for f in doc["fields"]])
        self.assertEqual((root / "modules.txt").read_text().strip(), "Send21 Payments")


if __name__ == "__main__":
    unittest.main()
