"""Offline tests: send21 MCP calls are replaced by a fake, webhooks are signed like send21 signs them.

    python -m unittest discover -s tests
"""
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import invoice_agent  # noqa: E402
import webhook_server  # noqa: E402

SECRET = "test-secret"
OPTIONS = [{"currency": "Usdc", "network": "Solana", "address": "So1anaAddre55"}]


def signed(event, data, delivery=None, age=0, secret=SECRET):
    delivery = delivery or str(uuid.uuid4())
    raw = json.dumps({"event": event, "data": data}).encode()
    t = str(int(time.time()) - age)
    v1 = hmac.new(secret.encode(), t.encode() + b"." + delivery.encode() + b"." + raw, hashlib.sha256).hexdigest()
    return {"X-Send21-Delivery": delivery, "X-Send21-Signature-V2": f"t={t},v1={v1}"}, raw


class FakeSend21:
    def __init__(self, approved=True):
        self.calls, self.approved = [], approved

    def __call__(self, name, args):
        self.calls.append((name, args))
        if name == "create_payment_request":
            if not self.approved:
                return {"error": "send21 API returned 422: address_not_approved"}
            return {"id": "pr-1", "payPath": "/pay/abc", "expiresAt": "2026-10-25T10:00:00.000Z"}
        if name == "list_address_book":
            return []
        if name == "propose_receiving_address":
            return {"id": "ab-1", "verifiedAt": None}
        raise AssertionError(name)


class InvoiceAgentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        invoice_agent.DB_PATH = os.path.join(self.tmp.name, "inv.db")
        os.environ["SEND21_RECEIVE_OPTIONS"] = json.dumps(OPTIONS)
        os.environ.pop("SMTP_HOST", None)
        self.fake = FakeSend21()
        invoice_agent.call_tool = self.fake
        self.graph = invoice_agent.open_graph()

    def tearDown(self):
        self.tmp.cleanup()

    def new(self, **kw):
        fields = {"client_name": "Acme", "client_email": "ap@acme.example", "amount": 250, "currency": "eur", "invoice_id": "INV-1"}
        fields.update(kw)
        return invoice_agent.create(fields, self.graph)

    def deliver(self, event, data, **kw):
        h, raw = signed(event, data, **kw)
        return webhook_server.handle_delivery(h, raw, SECRET, self.graph)

    def confirmed(self, **over):
        d = {"orderId": "INV-1", "paymentRequestId": "pr-1", "fiatAmount": 250, "fiatCurrency": "EUR", "txId": "tx1",
             "network": "Solana", "sentCurrency": "USDC", "sentAmount": "270.000000", "draftId": "d1"}
        d.update(over)
        return d

    def state(self):
        return self.graph.get_state({"configurable": {"thread_id": "INV-1"}})

    def test_create_uses_configured_addresses_and_idempotency(self):
        out = self.new()
        self.assertEqual(out["status"], "sent")
        self.assertEqual(out["pay_link"], "https://send21.io/pay/abc")
        name, args = self.fake.calls[0]
        self.assertEqual(name, "create_payment_request")
        self.assertEqual(args["options"], OPTIONS)
        self.assertEqual(args["fiatCurrency"], "EUR")
        self.assertEqual(args["idempotencyKey"], "invoice-INV-1")
        self.assertTrue(args["reuseOpenForOrder"])
        self.assertIn("wait_for_payment", self.state().next)

    def test_create_twice_does_not_bill_twice(self):
        self.new(); self.new()
        self.assertEqual([c[0] for c in self.fake.calls], ["create_payment_request"])

    def test_signed_confirmed_marks_paid_and_retry_is_ignored(self):
        self.new()
        h, raw = signed("draft.confirmed", self.confirmed(), delivery="dlv-1")
        self.assertEqual(webhook_server.handle_delivery(h, raw, SECRET, self.graph), (200, "ok, invoice INV-1 is paid"))
        self.assertEqual(webhook_server.handle_delivery(h, raw, SECRET, self.graph), (200, "duplicate delivery, ignored"))
        self.assertEqual(self.state().values["paid"]["txId"], "tx1")
        self.assertEqual(self.state().next, ())

    def test_bad_stale_or_missing_signature_is_401(self):
        self.new()
        self.assertEqual(self.deliver("draft.confirmed", self.confirmed(), secret="wrong")[0], 401)
        self.assertEqual(self.deliver("draft.confirmed", self.confirmed(), age=301)[0], 401)
        self.assertEqual(webhook_server.handle_delivery({}, b"{}", SECRET, self.graph)[0], 401)
        self.assertIn("wait_for_payment", self.state().next)

    def test_wrong_amount_is_not_paid(self):
        self.new()
        code, text = self.deliver("draft.confirmed", self.confirmed(fiatAmount=200))
        self.assertEqual((code, self.state().values["status"]), (200, "needs_review"))
        self.assertIn("wait_for_payment", self.state().next)

    def test_amount_mismatch_waits_for_the_human_then_confirmed_pays(self):
        self.new()
        self.deliver("draft.amount_mismatch", {"orderId": "INV-1", "paymentRequestId": "pr-1"})
        self.assertEqual(self.state().values["status"], "needs_review")
        self.assertNotIn("accept", json.dumps(self.fake.calls))
        self.deliver("draft.confirmed", self.confirmed(receivedAmountSats=268000000))
        self.assertEqual(self.state().values["status"], "paid")

    def test_unapproved_address_is_proposed_not_used(self):
        self.fake.approved = False
        out = self.new()
        self.assertEqual(out["status"], "needs_approval")
        self.assertEqual([c[0] for c in self.fake.calls], ["create_payment_request", "list_address_book", "propose_receiving_address"])

    def test_invalid_input_creates_nothing(self):
        out = self.new(amount=0, currency="EURO", invoice_id="INV-2")
        self.assertEqual(out["status"], "failed")
        self.assertEqual(self.fake.calls, [])

    def test_unsupported_option_is_refused(self):
        os.environ["SEND21_RECEIVE_OPTIONS"] = json.dumps([{"currency": "Usdt", "network": "Base", "address": "0xabc"}])
        with self.assertRaises(SystemExit):
            self.new()

    def test_free_text_intake_with_a_model(self):
        class Fake:
            def with_structured_output(self, schema):
                return self

            def invoke(self, prompt):
                class F:
                    client_name, client_email, amount, currency, memo = "Acme", "ap@acme.example", 99.5, "SEK", "Logo"
                return F()
        invoice_agent.MODEL_FACTORY = Fake
        try:
            out = invoice_agent.create({"request_text": "Bill Acme 99.50 SEK for the logo", "invoice_id": "INV-1"}, self.graph)
        finally:
            invoice_agent.MODEL_FACTORY = None
        self.assertEqual((out["status"], out["amount"], out["currency"]), ("sent", 99.5, "SEK"))


if __name__ == "__main__":
    unittest.main()
