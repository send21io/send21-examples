"""send21 invoice agent for LangGraph.

Takes a client, an amount and a currency, creates a send21 pay link over the send21 MCP
server, emails (or prints) the link, then pauses until the signed draft.confirmed webhook
arrives (see webhook_server.py) and marks the invoice paid.

    python invoice_agent.py create --client "Acme Ltd" --email ap@acme.example --amount 250 --currency EUR --memo "Logo design"
    python invoice_agent.py create --text "Bill Acme 250 EUR for the logo, ap@acme.example"   # needs SEND21_LLM_MODEL
    python invoice_agent.py status INV-...

The agent proposes, a human approves: it only uses the receiving addresses you set in
SEND21_RECEIVE_OPTIONS, which must be approved by you in the send21 app. It never signs,
sends or approves anything. send21 never holds keys or funds; the client pays from their
own wallet.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import re
import secrets
import smtplib
import sqlite3
import sys
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any, Literal, Optional, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

MCP_URL = os.environ.get("SEND21_MCP_URL", "https://send21.io/mcp")
DB_PATH = os.environ.get("INVOICE_DB", "invoices.db")
PAY_BASE = "https://send21.io"
MODEL_FACTORY = None  # tests can swap in a fake chat model
# send21 supports USDT on Solana and Ethereum only, USDC on Solana/Ethereum/Base/Arbitrum/Polygon,
# EURC on Solana/Ethereum/Base, BTC on-chain (Mainnet) and over Lightning (method Lightning).
SUPPORTED = {
    ("Btc", "Mainnet"), ("Usdc", "Solana"), ("Usdt", "Solana"), ("Eurc", "Solana"), ("Sol", "Solana"), ("Btc", "Solana"),
    ("Usdc", "Ethereum"), ("Usdt", "Ethereum"), ("Eurc", "Ethereum"), ("Eth", "Ethereum"), ("Btc", "Ethereum"),
    ("Usdc", "Base"), ("Eurc", "Base"), ("Eth", "Base"), ("Usdc", "Arbitrum"), ("Eth", "Arbitrum"), ("Usdc", "Polygon"),
}


class Invoice(TypedDict, total=False):
    invoice_id: str
    client_name: str
    client_email: str
    amount: float
    currency: str
    memo: str
    request_text: str
    payment_request_id: str
    pay_link: str
    expires_at: str
    status: Literal["new", "sent", "needs_approval", "needs_review", "paid", "expired", "failed"]
    emailed: bool
    error: str
    proposed: list
    event: dict
    paid: dict
    notes: list


# ---------------------------------------------------------------- send21 MCP


def call_tool(name: str, args: dict) -> Any:
    """Calls one send21 MCP tool and returns its JSON result, or {"error": text}."""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    key = os.environ.get("SEND21_API_KEY", "")
    if not key.startswith("s21_"):
        raise SystemExit("Set SEND21_API_KEY to a send21 API key (s21_...). Create one at https://send21.io/api-keys")

    async def run() -> Any:
        client = MultiServerMCPClient({"send21": {"transport": "streamable_http", "url": MCP_URL,
                                                  "headers": {"Authorization": f"Bearer {key}"}}})
        tools = {t.name: t for t in await client.get_tools()}
        return await tools[name].ainvoke(args)

    result = asyncio.run(run())
    text = result if isinstance(result, str) else "".join(
        b.get("text", "") for b in result if isinstance(b, dict) and b.get("type") == "text")
    try:
        return json.loads(text)
    except ValueError:
        return {"error": text}


def receive_options() -> list[dict]:
    """Your own receiving addresses, set by you (never by the client or the model)."""
    raw = os.environ.get("SEND21_RECEIVE_OPTIONS", "").strip()
    if not raw:
        raise SystemExit('Set SEND21_RECEIVE_OPTIONS, e.g. [{"currency":"Usdc","network":"Solana","address":"YourSolanaAddress"}]')
    options = json.loads(raw)
    for o in options:
        if (o.get("currency"), o.get("network")) not in SUPPORTED:
            raise SystemExit(f"{o.get('currency')} on {o.get('network')} is not supported by send21")
        if o.get("method") == "Lightning" and (o["currency"], o["network"]) != ("Btc", "Mainnet"):
            raise SystemExit("Lightning is only for Btc on Mainnet (a Lightning address name@wallet.com)")
    return options


# ---------------------------------------------------------------- graph nodes


def intake(state: Invoice) -> dict:
    """Optional: turn a free-text request into fields with an LLM (SEND21_LLM_MODEL, e.g. openai:gpt-4.1-mini)."""
    if not state.get("request_text"):
        return {}
    from pydantic import BaseModel, Field
    from langchain.chat_models import init_chat_model

    class Fields(BaseModel):
        client_name: str = Field(description="Who is billed")
        client_email: str = Field(description="Client email address, empty if not given")
        amount: float = Field(description="Amount in the fiat currency")
        currency: str = Field(description="3-letter fiat currency code, e.g. EUR")
        memo: str = Field(description="Short description of what is billed")

    model = MODEL_FACTORY() if MODEL_FACTORY else init_chat_model(os.environ["SEND21_LLM_MODEL"])
    f = model.with_structured_output(Fields).invoke(
        "Extract the invoice fields. Do not invent an email or an amount that is not in the text.\n\n" + state["request_text"])
    return {k: getattr(f, k) for k in ("client_name", "client_email", "amount", "currency", "memo") if not state.get(k)}


def validate(state: Invoice) -> dict:
    errors = []
    amount = round(float(state.get("amount") or 0), 2)
    currency = str(state.get("currency") or "").upper()
    if not state.get("client_name"):
        errors.append("client name is required")
    if state.get("client_email") and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", state["client_email"]):
        errors.append("client email is not an email address")
    if amount <= 0:
        errors.append("amount must be above 0")
    if not re.fullmatch(r"[A-Z]{3}", currency):
        errors.append("currency must be a 3-letter code such as EUR")
    if errors:
        return {"status": "failed", "error": "; ".join(errors)}
    return {"amount": amount, "currency": currency, "status": "new"}


def create_link(state: Invoice) -> dict:
    args = {
        "fiatCurrency": state["currency"],
        "fiatAmount": state["amount"],
        "options": receive_options(),
        "orderId": state["invoice_id"],
        "memo": f"Invoice {state['invoice_id']}" + (f": {state['memo']}" if state.get("memo") else ""),
        "expiryHours": int(os.environ.get("SEND21_EXPIRY_HOURS", "72")),
        # a retry with the same invoice returns the same link; another amount is refused with 422
        "idempotencyKey": f"invoice-{state['invoice_id']}",
        "reuseOpenForOrder": True,
    }
    res = call_tool("create_payment_request", args)
    if isinstance(res, dict) and res.get("payPath"):
        return {"payment_request_id": res["id"], "pay_link": PAY_BASE + res["payPath"], "expires_at": res.get("expiresAt", ""), "status": "sent"}
    text = json.dumps(res)
    if "address_not_approved" in text:
        return {"status": "needs_approval", "error": text[:400]}
    return {"status": "failed", "error": text[:400]}


def propose_addresses(state: Invoice) -> dict:
    """Agent proposes, human approves: propose the configured addresses that are not approved yet.

    No API key can approve an address. You approve it yourself in the send21 app with a passkey
    or an authenticator code, then run `create` again with the same invoice id.
    """
    book = call_tool("list_address_book", {})
    known = {(e.get("address"), e.get("network")) for e in book} if isinstance(book, list) else set()
    proposed = []
    for o in receive_options():
        if (o["address"], o["network"]) in known:
            continue
        res = call_tool("propose_receiving_address", {"label": f"Invoice agent {o['network']} {o['address'][:6]}",
                                                      "address": o["address"], "network": o["network"], "direction": "Receiving"})
        proposed.append({"address": o["address"], "network": o["network"], "result": res})
    return {"proposed": proposed}


def send_link(state: Invoice) -> dict:
    text = (f"Hi {state['client_name']},\n\nhere is invoice {state['invoice_id']} for {state['amount']:.2f} {state['currency']}"
            f"{' (' + state['memo'] + ')' if state.get('memo') else ''}.\n\nPay here: {state['pay_link']}\n\n"
            "Pick a currency, scan the QR code and pay from your own wallet. The rate locks for 15 minutes once you pick.\n")
    host = os.environ.get("SMTP_HOST")
    if not (host and state.get("client_email")):
        return {"emailed": False}
    msg = EmailMessage()
    msg["From"] = os.environ.get("SMTP_FROM", "invoices@example.com")
    msg["To"] = state["client_email"]
    msg["Subject"] = f"Invoice {state['invoice_id']}: {state['amount']:.2f} {state['currency']}"
    msg.set_content(text)
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", "587")), timeout=20) as s:
        if os.environ.get("SMTP_STARTTLS", "1") == "1":
            s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)
    return {"emailed": True}


def wait_for_payment(state: Invoice) -> dict:
    """Pauses the graph. webhook_server.py resumes it with a VERIFIED, NEW send21 delivery."""
    event = interrupt({"waiting_for": "draft.confirmed", "invoice_id": state["invoice_id"],
                       "payment_request_id": state["payment_request_id"]})
    return {"event": event}


def handle_event(state: Invoice) -> dict:
    ev = state.get("event") or {}
    name, data = ev.get("event"), ev.get("data") or {}
    notes = list(state.get("notes") or [])
    if name == "draft.confirmed":
        wrong = []
        if data.get("orderId") != state["invoice_id"]:
            wrong.append("orderId")
        if data.get("paymentRequestId") and data["paymentRequestId"] != state["payment_request_id"]:
            wrong.append("paymentRequestId")
        if str(data.get("fiatCurrency", "")).upper() != state["currency"] or abs(float(data.get("fiatAmount") or 0) - state["amount"]) > 0.005:
            wrong.append("amount or currency")
        if wrong:
            notes.append(f"draft.confirmed did not match the invoice ({', '.join(wrong)}); not marked paid")
            return {"status": "needs_review", "notes": notes}
        paid = {k: data.get(k) for k in ("draftId", "txId", "network", "sentCurrency", "sentAmount", "occurredAt", "quoteId")}
        if data.get("receivedAmountSats") is not None:
            notes.append("paid after you accepted a different amount in send21")
        return {"status": "paid", "paid": paid, "notes": notes}
    if name == "draft.amount_mismatch":
        notes.append("a transfer with a different amount arrived: accept or decline it yourself in send21; the agent never decides")
        return {"status": "needs_review", "notes": notes}
    if name in ("payment_request.expired", "draft.expired") and state.get("status") != "paid":
        notes.append(f"{name}: opened={data.get('opened')}, picked a currency={data.get('quoteRequested')}")
        return {"status": "expired", "notes": notes}
    return {"notes": notes}


def record(state: Invoice) -> dict:
    with contextlib.closing(sqlite3.connect(DB_PATH)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS invoices (invoice_id TEXT PRIMARY KEY, payment_request_id TEXT, client_name TEXT,"
                   " client_email TEXT, amount REAL, currency TEXT, pay_link TEXT, status TEXT, paid_json TEXT, updated_at TEXT)")
        db.execute("INSERT INTO invoices VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(invoice_id) DO UPDATE SET"
                   " payment_request_id=excluded.payment_request_id, pay_link=excluded.pay_link, status=excluded.status,"
                   " paid_json=excluded.paid_json, updated_at=excluded.updated_at",
                   (state["invoice_id"], state.get("payment_request_id"), state.get("client_name"), state.get("client_email"),
                    state.get("amount"), state.get("currency"), state.get("pay_link"), state.get("status"),
                    json.dumps(state.get("paid")) if state.get("paid") else None, datetime.now(timezone.utc).isoformat()))
    return {}


# ---------------------------------------------------------------- graph


def after_validate(state: Invoice) -> str:
    return "create_link" if state.get("status") == "new" else "record_end"


def after_create(state: Invoice) -> str:
    return {"sent": "send_link", "needs_approval": "propose_addresses"}.get(state.get("status"), "record_end")


def after_event(state: Invoice) -> str:
    # an amount mismatch or a non-matching delivery keeps waiting: the human decides in send21,
    # and a later draft.confirmed (after they accept) or an expiry ends it
    return "record_end" if state.get("status") in ("paid", "expired") else "record_wait"


def build_graph(checkpointer):
    g = StateGraph(Invoice)
    g.add_node("intake", intake)
    g.add_node("validate", validate)
    g.add_node("create_link", create_link)
    g.add_node("propose_addresses", propose_addresses)
    g.add_node("send_link", send_link)
    g.add_node("record_sent", record)
    g.add_node("wait_for_payment", wait_for_payment)
    g.add_node("handle_event", handle_event)
    g.add_node("record_wait", record)
    g.add_node("record_end", record)
    g.add_edge(START, "intake")
    g.add_edge("intake", "validate")
    g.add_conditional_edges("validate", after_validate, ["create_link", "record_end"])
    g.add_conditional_edges("create_link", after_create, ["send_link", "propose_addresses", "record_end"])
    g.add_edge("propose_addresses", "record_end")
    g.add_edge("send_link", "record_sent")
    g.add_edge("record_sent", "wait_for_payment")
    g.add_edge("wait_for_payment", "handle_event")
    g.add_conditional_edges("handle_event", after_event, ["record_end", "record_wait"])
    g.add_edge("record_wait", "wait_for_payment")
    g.add_edge("record_end", END)
    return g.compile(checkpointer=checkpointer)


def open_graph():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    return build_graph(SqliteSaver(conn))


def new_invoice_id() -> str:
    return "INV-" + datetime.now(timezone.utc).strftime("%Y%m%d") + "-" + secrets.token_hex(3).upper()


def create(fields: dict, graph=None) -> dict:
    graph = graph or open_graph()
    fields.setdefault("invoice_id", new_invoice_id())
    cfg = {"configurable": {"thread_id": fields["invoice_id"]}}
    existing = graph.get_state(cfg)
    if existing.values and existing.values.get("status") not in (None, "failed", "needs_approval"):
        return existing.values  # this invoice already has a pay link; never bill twice
    graph.invoke(fields, cfg)
    return graph.get_state(cfg).values


def resume(invoice_id: str, event: dict, graph=None) -> Optional[dict]:
    """Feeds one verified webhook event to the waiting invoice. Returns None if nothing waits."""
    graph = graph or open_graph()
    cfg = {"configurable": {"thread_id": invoice_id}}
    if "wait_for_payment" not in (graph.get_state(cfg).next or ()):
        return None
    graph.invoke(Command(resume=event), cfg)
    return graph.get_state(cfg).values


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create", help="create an invoice pay link and wait for payment")
    c.add_argument("--client"); c.add_argument("--email", default="")
    c.add_argument("--amount", type=float); c.add_argument("--currency")
    c.add_argument("--memo", default=""); c.add_argument("--invoice-id")
    c.add_argument("--text", help="free-text request, parsed by SEND21_LLM_MODEL")
    s = sub.add_parser("status", help="show an invoice")
    s.add_argument("invoice_id")
    a = p.parse_args(argv)
    if a.cmd == "create":
        fields = {k: v for k, v in {"client_name": a.client, "client_email": a.email, "amount": a.amount, "currency": a.currency,
                                    "memo": a.memo, "invoice_id": a.invoice_id, "request_text": a.text}.items() if v}
        out = create(fields)
    else:
        out = open_graph().get_state({"configurable": {"thread_id": a.invoice_id}}).values
    out = dict(out or {})
    print(json.dumps(out, indent=2, default=str))
    return 0 if out.get("status") in ("sent", "paid", "needs_review", "expired") else 1


if __name__ == "__main__":
    sys.exit(main())
