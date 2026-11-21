"""Receiving addresses come from the environment, never from the model."""

from __future__ import annotations

import os
from typing import TypedDict


class PayOption(TypedDict, total=False):
    currency: str
    network: str
    address: str
    method: str


SUPPORTED: dict[str, list[str]] = {
    "Btc": ["Mainnet"],
    "Usdc": ["Solana", "Ethereum", "Base", "Arbitrum", "Polygon"],
    "Usdt": ["Solana", "Ethereum"],
    "Eurc": ["Solana", "Ethereum", "Base"],
    "Sol": ["Solana"],
    "Eth": ["Ethereum", "Base", "Arbitrum"],
}

MCP_URL = "https://send21.io/mcp"
SITE = "https://send21.io"

SYSTEM_PROMPT = """You prepare send21 pay links and payment drafts for a person to review.

Rules:
- Use the send21 MCP tools to create a payment request (pay link) or a draft, then read its status if asked.
- You only prepare payment instructions. You cannot move funds. A person signs and sends the payment from their own wallet. send21 never holds keys or funds, never signs and never broadcasts.
- The key cannot move funds at all, so there is nothing here to describe as a cap on spending.
- Receiving addresses are supplied by the operator, not by you. Do not invent or change addresses.
- When you create a pay link, return the full https://send21.io pay link, the payment request id, the order id and the expiry.
- Prefer reuseOpenForOrder=true with an orderId so a retry returns the open link instead of creating a second one.
- Account keys use the live networks. The test networks are only for https://send21.io/demo.
"""


def receive_options(*, allow_placeholder: bool = False) -> list[PayOption]:
    opts: list[PayOption] = []
    if sol := os.environ.get("MY_SOLANA_ADDRESS"):
        opts.append({"currency": "Usdc", "network": "Solana", "address": sol})
    if base := os.environ.get("MY_BASE_ADDRESS"):
        opts.append({"currency": "Usdc", "network": "Base", "address": base})
    if ln := os.environ.get("MY_LIGHTNING_ADDRESS"):
        opts.append({"currency": "Btc", "network": "Mainnet", "address": ln, "method": "Lightning"})
    if not opts:
        if not allow_placeholder:
            raise SystemExit(
                "Set at least one of MY_SOLANA_ADDRESS, MY_BASE_ADDRESS, MY_LIGHTNING_ADDRESS"
            )
        opts.append({"currency": "Usdc", "network": "Solana", "address": "<your-solana-address>"})
    check_options(opts)
    return opts


def check_options(opts: list[PayOption]) -> None:
    for option in opts:
        currency, network = option["currency"], option["network"]
        if network not in SUPPORTED.get(currency, []):
            raise ValueError(f"{currency} on {network} is not supported")
        if option.get("method") == "Lightning" and currency != "Btc":
            raise ValueError("Lightning is only for Btc")


def pay_link(pay_path: str | None) -> str | None:
    if not pay_path:
        return None
    return SITE + pay_path
