"""Framework-free rules for the send21 Frappe app (no frappe import, unit-tested on its own).

Facts from https://send21.io/llms-full.txt and https://send21.io/swagger/v1/swagger.json:
POST /api/v1/payment-requests creates a pay link (https://send21.io + payPath); send an
Idempotency-Key; reuseOpenForOrder returns the open link for the same orderId; declineNote is
plain text up to 200 characters; expiryHours is 1-720 (default 24). Webhooks carry
X-Send21-Signature-V2 = t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<delivery id>.<raw body>">;
refuse deliveries older than 5 minutes. Retries reuse X-Send21-Delivery; send21 does not dedupe.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time

SEND21_BASE_URL = "https://send21.io"
TOLERANCE_SECONDS = 300
DECLINE_NOTE_MAX = 200
DEFAULT_DECLINE_NOTE = "The invoice stays open and our usual payment terms apply."
CURRENCIES = {"Btc", "Usdc", "Usdt", "Eurc", "Sol", "Eth"}
NETWORKS = {"Mainnet", "Solana", "Ethereum", "Base", "Arbitrum", "Polygon"}
METHODS = {"MultiOutput", "Lightning"}
REVIEW_EVENTS = {"draft.amount_mismatch", "draft.mismatch_reminder", "draft.mismatch_unresolved"}


def order_id_for(doctype: str, name: str) -> str:
    prefix = {"Sales Invoice": "erpnext-sinv"}.get(doctype, "erpnext-" + re.sub(r"[^a-z0-9]+", "-", doctype.lower()))
    return f"{prefix}-{name}"


def clean_decline_note(note: str | None) -> str:
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", "", note or "")).strip() or DEFAULT_DECLINE_NOTE
    return text if len(text) <= DECLINE_NOTE_MAX else text[: DECLINE_NOTE_MAX - 1].rstrip() + "…"


def parse_options(raw) -> list[dict]:
    items = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(items, list) or not items:
        raise ValueError("add at least one receiving option")
    out = []
    for i, o in enumerate(items, 1):
        if not isinstance(o, dict) or o.get("currency") not in CURRENCIES:
            raise ValueError(f"option {i}: unknown currency")
        if o.get("network") not in NETWORKS:
            raise ValueError(f"option {i}: unknown network")
        address = str(o.get("address") or "").strip()
        if len(address) < 3:
            raise ValueError(f"option {i}: address missing")
        item = {"currency": o["currency"], "network": o["network"], "address": address}
        if "method" in o:
            if o["method"] not in METHODS:
                raise ValueError(f"option {i}: unknown method")
            item["method"] = o["method"]
        out.append(item)
    return out


def build_payment_request(*, order_id: str, memo: str, amount, currency: str, options: list[dict],
                          decline_note: str | None = None, expiry_hours: int | None = 24) -> tuple[dict, str]:
    """Return (body, idempotency_key) for POST /api/v1/payment-requests."""
    fiat = round(float(amount), 2)
    if fiat <= 0:
        raise ValueError("nothing outstanding on this invoice")
    if not re.fullmatch(r"[A-Z]{3}", str(currency or "").upper()):
        raise ValueError("currency must be a 3-letter code")
    body = {
        "fiatCurrency": currency.upper(),
        "fiatAmount": fiat,
        "orderId": order_id,
        "memo": memo[:140],
        "expiryHours": max(1, min(720, int(expiry_hours or 24))),
        "declineNote": clean_decline_note(decline_note),
        "reuseOpenForOrder": True,
        "options": options,
    }
    return body, f"{order_id}-{fiat:.2f}"


def pay_link(pay_path: str) -> str:
    if not isinstance(pay_path, str) or not pay_path.startswith("/"):
        raise ValueError("payPath missing from the send21 response")
    return SEND21_BASE_URL + pay_path


def sign_v2(raw_body: bytes, delivery_id: str, timestamp: int | str, secret: str) -> str:
    mac = hmac.new(secret.encode(), f"{timestamp}.{delivery_id}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={mac}"


def verify_signature_v2(raw_body: bytes, header: str | None, delivery_id: str | None, secret: str | None,
                        now: float | None = None) -> bool:
    if not secret or not header or not delivery_id:
        return False
    t = re.search(r"(?:^|,)\s*t=(\d+)", header)
    v1 = re.search(r"(?:^|,)\s*v1=([0-9a-f]{64})", header)
    if not t or not v1:
        return False
    if abs((time.time() if now is None else now) - int(t.group(1))) > TOLERANCE_SECONDS:
        return False
    expected = sign_v2(raw_body, delivery_id, t.group(1), secret).split(",v1=")[1]
    return hmac.compare_digest(expected, v1.group(1))


def decide(event: str, data: dict, link: dict) -> dict:
    """link: the stored pay link (order_id, payment_request_id, amount, currency, status)."""
    if data.get("orderId") != link["order_id"]:
        return {"action": "ignore", "note": "orderId does not match"}
    if data.get("paymentRequestId") and link.get("payment_request_id") and data["paymentRequestId"] != link["payment_request_id"]:
        return {"action": "ignore", "note": "another pay link for this order"}
    if event == "draft.confirmed":
        if link.get("status") == "Paid":
            return {"action": "ignore", "note": "already paid"}
        same_currency = str(data.get("fiatCurrency", "")).upper() == str(link["currency"]).upper()
        same_amount = data.get("fiatAmount") is not None and round(float(data["fiatAmount"]), 2) == round(float(link["amount"]), 2)
        if not (same_currency and same_amount):
            return {"action": "review", "note": f"confirmed {data.get('fiatAmount')} {data.get('fiatCurrency')}, link was {link['amount']} {link['currency']}"}
        return {"action": "pay", "note": f"{data.get('sentAmount')} {data.get('sentCurrency')} on {data.get('network')}"}
    if event in REVIEW_EVENTS:
        return {"action": "review", "note": f"{event}: accept or decline the transfer in send21; refunds are manual"}
    if event == "payment_request.expired":
        if link.get("status") == "Paid":
            return {"action": "ignore", "note": "already paid"}
        return {"action": "expire", "note": "pay link expired unpaid" + (" (opened)" if data.get("opened") else "")}
    return {"action": "ignore", "note": f"event {event} not used"}
