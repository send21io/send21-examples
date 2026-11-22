"""send21 endpoints for Frappe / ERPNext.

- create_pay_link(sales_invoice): pay link for the outstanding amount, stored on the invoice.
- webhook: https://<site>/api/method/send21_payments.api.webhook, registered in send21.
"""

from __future__ import annotations

import json

import frappe
import requests
from frappe.utils import getdate

from send21_payments.send21_core import (
    SEND21_BASE_URL,
    build_payment_request,
    decide,
    order_id_for,
    parse_options,
    pay_link,
    verify_signature_v2,
)


def _settings():
    settings = frappe.get_single("Send21 Settings")
    if not settings.enabled:
        frappe.throw("send21 is not enabled in Send21 Settings.")
    return settings


@frappe.whitelist(methods=["POST"])
def create_pay_link(sales_invoice: str) -> str:
    invoice = frappe.get_doc("Sales Invoice", sales_invoice)
    invoice.check_permission("write")
    return _create_pay_link(invoice)


def _create_pay_link(invoice) -> str:
    if invoice.docstatus != 1 or invoice.outstanding_amount <= 0:
        frappe.throw("Only submitted invoices with an outstanding amount get a pay link.")
    settings = _settings()
    order_id = order_id_for("Sales Invoice", invoice.name)
    body, idempotency_key = build_payment_request(
        order_id=order_id,
        memo=f"Invoice {invoice.name}",
        amount=invoice.outstanding_amount,
        currency=invoice.currency,
        options=parse_options(settings.receive_options),
        decline_note=settings.decline_note,
        expiry_hours=settings.expiry_hours,
    )
    response = requests.post(
        f"{SEND21_BASE_URL}/api/v1/payment-requests",
        json=body,
        headers={
            "Authorization": f"Bearer {settings.get_password('api_key')}",
            "Idempotency-Key": idempotency_key,
        },
        timeout=20,
    )
    if not response.ok:
        frappe.throw(f"send21 API error {response.status_code}")
    data = response.json()
    link = pay_link(data.get("payPath"))

    values = {
        "status": "Open",
        "reference_doctype": "Sales Invoice",
        "reference_name": invoice.name,
        "pay_link": link,
        "payment_request_id": data.get("id"),
        "amount": body["fiatAmount"],
        "currency": body["fiatCurrency"],
    }
    if frappe.db.exists("Send21 Pay Link", order_id):
        frappe.db.set_value("Send21 Pay Link", order_id, values)
    else:
        frappe.get_doc({"doctype": "Send21 Pay Link", "order_id": order_id, **values}).insert(ignore_permissions=True)
    invoice.db_set("send21_pay_link", link)
    return link


def on_sales_invoice_submit(doc, method=None):
    settings = frappe.get_single("Send21 Settings")
    if settings.enabled and settings.auto_create_on_submit and doc.outstanding_amount > 0:
        _create_pay_link(doc)


@frappe.whitelist(allow_guest=True, methods=["POST"])
def webhook():
    raw = frappe.request.get_data() or b""
    headers = frappe.request.headers
    delivery_id = headers.get("X-Send21-Delivery")
    settings = frappe.get_single("Send21 Settings")
    secret = settings.get_password("webhook_secret", raise_exception=False)

    # Check the signature on the raw bytes before reading anything.
    if not verify_signature_v2(raw, headers.get("X-Send21-Signature-V2"), delivery_id, secret):
        frappe.local.response["http_status_code"] = 401
        return {"ok": False}

    # Retries reuse X-Send21-Delivery and send21 does not dedupe. The delivery row is written
    # in the same database transaction as the Payment Entry, so either both happen or neither.
    if frappe.db.exists("Send21 Webhook Delivery", delivery_id):
        return {"ok": True, "duplicate": True}

    payload = json.loads(raw)
    event, data = payload.get("event", ""), payload.get("data") or {}
    order_id = data.get("orderId")
    result = {"action": "ignore", "note": "unknown order"}
    if order_id and frappe.db.exists("Send21 Pay Link", order_id):
        link = frappe.get_doc("Send21 Pay Link", order_id)
        result = decide(event, data, link.as_dict())
        _apply(result, data, link, settings)

    frappe.get_doc(
        {"doctype": "Send21 Webhook Delivery", "delivery_id": delivery_id, "event": event, "result": json.dumps(result)}
    ).insert(ignore_permissions=True)
    return {"ok": True, "action": result["action"]}


def _apply(result, data, link, settings):
    if result["action"] == "pay":
        from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry

        pe = get_payment_entry(link.reference_doctype, link.reference_name, party_amount=link.amount)
        if settings.mode_of_payment:
            pe.mode_of_payment = settings.mode_of_payment
        if settings.paid_to_account:
            pe.paid_to = settings.paid_to_account
        pe.reference_no = str(data.get("txId") or "")[:140]
        pe.reference_date = getdate(str(data.get("confirmedAt") or "")[:10] or None)
        pe.remarks = (
            f"send21 {data.get('sentAmount')} {data.get('sentCurrency')} on {data.get('network')}, "
            f"tx {data.get('txId')}, rate {data.get('conversionRate')} ({data.get('rateSource')}), "
            f"quote {data.get('quoteId')}, draft {data.get('draftId')}"
        )
        pe.flags.ignore_permissions = True
        pe.insert()
        pe.submit()
        link.db_set({"status": "Paid", "tx_id": data.get("txId"), "payment_entry": pe.name, "note": result["note"]})
    elif result["action"] == "review":
        link.db_set({"status": "Needs review", "note": result["note"]})
    elif result["action"] == "expire":
        link.db_set({"status": "Expired", "note": result["note"]})
