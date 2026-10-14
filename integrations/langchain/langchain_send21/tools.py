from __future__ import annotations

import os
import uuid
from typing import Any, Literal, Optional
from urllib.parse import urljoin

import httpx
from langchain_core.tools import BaseTool, BaseToolkit
from pydantic import BaseModel, Field, PrivateAttr

# Supported asset/network pairs. USDT only on Solana and Ethereum, no ETH on Polygon.
SUPPORTED = {
    "Btc": {"Mainnet"},
    "Usdc": {"Solana", "Ethereum", "Base", "Arbitrum", "Polygon"},
    "Usdt": {"Solana", "Ethereum"},
    "Eurc": {"Solana", "Ethereum", "Base"},
    "Sol": {"Solana"},
    "Eth": {"Ethereum", "Base", "Arbitrum"},
}


class PayOption(BaseModel):
    currency: Literal["Btc", "Usdc", "Usdt", "Eurc", "Sol", "Eth"]
    network: Literal["Mainnet", "Solana", "Ethereum", "Base", "Arbitrum", "Polygon"]
    address: str = Field(description="The receiver's own address, or Lightning address name@wallet.com")
    method: Optional[Literal["MultiOutput", "Lightning"]] = None

    def check(self) -> None:
        if self.network not in SUPPORTED[self.currency]:
            raise ValueError(f"{self.currency} is not supported on {self.network}")
        if self.method == "Lightning" and self.currency != "Btc":
            raise ValueError("Lightning is only for Btc")


class Send21Client:
    """Thin REST client. Uses a scoped send21 API key (https://send21.io/api-keys)."""

    def __init__(self, api_key: str | None = None, base_url: str = "https://send21.io",
                 http: httpx.Client | None = None) -> None:
        self.api_key = api_key or os.environ.get("SEND21_API_KEY")
        if not self.api_key:
            raise ValueError("Set SEND21_API_KEY (create a scoped key at https://send21.io/api-keys)")
        self.base_url = base_url.rstrip("/")
        self.http = http or httpx.Client(timeout=30)

    def _req(self, method: str, path: str, **kw: Any) -> dict:
        headers = {"Authorization": f"Bearer {self.api_key}", **kw.pop("headers", {})}
        r = self.http.request(method, self.base_url + path, headers=headers, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"send21 {r.status_code}: {r.text[:500]}")
        return r.json()

    def create_payment_request(self, body: dict) -> dict:
        return self._req("POST", "/api/v1/payment-requests", json=body,
                         headers={"Idempotency-Key": str(uuid.uuid4())})

    def get_payment_request(self, pr_id: str) -> dict:
        return self._req("GET", f"/api/v1/payment-requests/{pr_id}")


class CreatePayLinkInput(BaseModel):
    fiat_amount: float = Field(gt=0, description="Amount in the fiat currency")
    fiat_currency: str = Field(min_length=3, max_length=3, description="ISO 4217 code, e.g. EUR")
    order_id: Optional[str] = Field(None, description="Your reference, echoed in webhooks")
    memo: Optional[str] = Field(None, max_length=500)
    decline_note: Optional[str] = Field(None, max_length=200, description="Shown as 'If you don't pay:'")


class Send21CreatePayLinkTool(BaseTool):
    name: str = "send21_create_pay_link"
    description: str = (
        "Create a send21 pay link so a human can pay you. Returns a link; the payer picks a currency, "
        "scans one QR and signs in their own wallet. This tool cannot move funds."
    )
    args_schema: type[BaseModel] = CreatePayLinkInput
    receive_options: list[PayOption]
    _client: Send21Client = PrivateAttr()

    def __init__(self, client: Send21Client, receive_options: list[PayOption], **kw: Any) -> None:
        super().__init__(receive_options=receive_options, **kw)
        for o in receive_options:
            o.check()
        self._client = client

    def _run(self, fiat_amount: float, fiat_currency: str, order_id: str | None = None,
             memo: str | None = None, decline_note: str | None = None, **_: Any) -> dict:
        pr = self._client.create_payment_request({
            "fiatAmount": fiat_amount,
            "fiatCurrency": fiat_currency.upper(),
            "options": [o.model_dump(exclude_none=True) for o in self.receive_options],
            "orderId": order_id,
            "memo": memo,
            "declineNote": decline_note,
            "reuseOpenForOrder": True if order_id else None,
        })
        return {
            "payment_request_id": pr["id"],
            "pay_link": urljoin(self._client.base_url + "/", pr["payPath"].lstrip("/")),
            "status": pr.get("status"),
            "expires_at": pr.get("expiresAt"),
        }


class StatusInput(BaseModel):
    payment_request_id: str


class Send21GetPayLinkStatusTool(BaseTool):
    name: str = "send21_get_pay_link_status"
    description: str = "Get the status of a send21 pay link (Open, Completed, Cancelled, Expired)."
    args_schema: type[BaseModel] = StatusInput
    _client: Send21Client = PrivateAttr()

    def __init__(self, client: Send21Client, **kw: Any) -> None:
        super().__init__(**kw)
        self._client = client

    def _run(self, payment_request_id: str, **_: Any) -> dict:
        pr = self._client.get_payment_request(payment_request_id)
        return {"status": pr.get("status"), "draft_status": pr.get("draftStatus"),
                "expires_at": pr.get("expiresAt"), "change_notes": pr.get("changeNotes") or []}


class Send21Toolkit(BaseToolkit):
    """Both tools. Receiving addresses are fixed by the app, never chosen by the model."""

    receive_options: list[PayOption]
    api_key: Optional[str] = None
    base_url: str = "https://send21.io"

    def get_tools(self) -> list[BaseTool]:
        c = Send21Client(self.api_key, self.base_url)
        return [Send21CreatePayLinkTool(c, self.receive_options), Send21GetPayLinkStatusTool(c)]
