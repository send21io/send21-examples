"""Receives send21 webhooks and resumes the waiting invoice graph.

    SEND21_WEBHOOK_SECRET=... python webhook_server.py      # listens on :8021, POST /send21/webhook

For every delivery it:
1. verifies X-Send21-Signature-V2 (t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<delivery id>.<raw body>">) over the
   raw body bytes, in constant time, and refuses deliveries more than 300 seconds (5 minutes) old: 401;
2. ignores a delivery id it already handled. send21 retries a delivery (up to 8 attempts) with the
   same X-Send21-Delivery id, and deliveries can arrive out of order, so deduplicating is the
   receiver's job; this server keeps the ids in SQLite;
3. resumes the invoice whose orderId the event carries, which checks amount, currency, orderId and
   pay link id before it marks the invoice paid.

Put it behind HTTPS on a public address (send21 refuses private and internal endpoints), then
register the URL once:  python webhook_server.py --register https://your-host/send21/webhook
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import invoice_agent

MAX_AGE_SECONDS = 300
_lock = threading.Lock()  # one delivery at a time keeps the dedupe check and the resume together


def verify_v2(secret: str, headers, raw: bytes, now: float | None = None) -> tuple[bool, str]:
    sig = headers.get("X-Send21-Signature-V2", "") or ""
    delivery_id = headers.get("X-Send21-Delivery", "") or ""
    t = re.search(r"(?:^|,)t=(\d+)", sig)
    v1 = re.search(r"(?:^|,)v1=([0-9a-f]{64})", sig)
    if not secret:
        return False, "SEND21_WEBHOOK_SECRET is not set"
    if not (t and v1 and delivery_id):
        return False, "missing X-Send21-Signature-V2 or X-Send21-Delivery"
    if abs((now or time.time()) - int(t.group(1))) > MAX_AGE_SECONDS:
        return False, "delivery more than 5 minutes old"
    signed = t.group(1).encode() + b"." + delivery_id.encode() + b"." + raw
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, v1.group(1)):
        return False, "signature does not match"
    return True, delivery_id


def _db():
    db = sqlite3.connect(invoice_agent.DB_PATH)
    db.execute("CREATE TABLE IF NOT EXISTS deliveries (delivery_id TEXT PRIMARY KEY, event TEXT, order_id TEXT, handled_at TEXT)")
    return db


def handle_delivery(headers, raw: bytes, secret: str, graph=None) -> tuple[int, str]:
    ok, info = verify_v2(secret, headers, raw)
    if not ok:
        return 401, info
    delivery_id = info
    try:
        payload = json.loads(raw)
    except ValueError:
        return 400, "body is not JSON"
    event, data = payload.get("event"), payload.get("data") or {}
    with _lock:
        db = _db()
        try:
            if db.execute("SELECT 1 FROM deliveries WHERE delivery_id=?", (delivery_id,)).fetchone():
                return 200, "duplicate delivery, ignored"
            invoice_id = data.get("orderId")
            if not invoice_id and data.get("paymentRequestId"):
                row = db.execute("SELECT invoice_id FROM invoices WHERE payment_request_id=?", (data["paymentRequestId"],)).fetchone() \
                    if db.execute("SELECT name FROM sqlite_master WHERE name='invoices'").fetchone() else None
                invoice_id = row[0] if row else None
            result = invoice_agent.resume(invoice_id, payload, graph) if invoice_id else None
            # recorded only after the invoice was updated: a crash before this line means send21's
            # retry is processed again, and resume() is a no-op once the invoice stopped waiting
            db.execute("INSERT INTO deliveries VALUES (?,?,?,datetime('now'))", (delivery_id, event, invoice_id))
            db.commit()
        finally:
            db.close()
    if result is None:
        return 200, f"ok, nothing waiting for {invoice_id or 'this event'}"
    return 200, f"ok, invoice {invoice_id} is {result.get('status')}"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/send21/webhook":
            self.send_error(404)
            return
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        code, text = handle_delivery(self.headers, raw, os.environ.get("SEND21_WEBHOOK_SECRET", ""))
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(text.encode())
        print(code, text, flush=True)

    def log_message(self, *args):
        pass


def register(url: str) -> None:
    """POST /api/v1/webhooks once (scope webhooks:manage). The secret is shown only once."""
    import urllib.request
    body = json.dumps({"url": url, "events": ["draft.confirmed", "draft.amount_mismatch", "draft.mismatch_accepted",
                                               "payment_request.expired"]}).encode()
    req = urllib.request.Request("https://send21.io/api/v1/webhooks", data=body, method="POST", headers={
        "Authorization": "Bearer " + os.environ["SEND21_API_KEY"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.load(r)
    print(f"Webhook {res.get('id')} registered. Store this secret as SEND21_WEBHOOK_SECRET now (shown only once):")
    print(res.get("secret"))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--register":
        register(sys.argv[2])
    else:
        port = int(os.environ.get("PORT", "8021"))
        print(f"send21 webhook receiver on :{port}/send21/webhook", flush=True)
        ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
