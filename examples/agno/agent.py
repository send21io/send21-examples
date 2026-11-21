#!/usr/bin/env python3
"""An Agno agent that prepares a send21 pay link or draft over MCP.

The agent cannot move funds. A person signs and sends from their own wallet.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

from pay_options import MCP_URL, SYSTEM_PROMPT, receive_options
from rest import create_payment_request, get_payment_request

_env = Path(__file__).resolve().parent / ".env"
if _env.exists():
    for line in _env.read_text().splitlines():
        if line.strip() and not line.lstrip().startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _api_key() -> str | None:
    return os.environ.get("SEND21_API_KEY") or None


async def dry_run() -> None:
    opts = receive_options(allow_placeholder=True)
    print(
        json.dumps(
            {
                "mcp": MCP_URL,
                "tool": "create_payment_request",
                "arguments": {
                    "fiatCurrency": "EUR",
                    "fiatAmount": 25,
                    "orderId": "inv-dry-run",
                    "reuseOpenForOrder": True,
                    "idempotencyKey": "dry-run-not-sent",
                    "options": opts,
                },
                "note": "Nothing was created. The agent only prepares a pay link; a person signs and sends from their own wallet.",
            },
            indent=2,
        )
    )
    print("\nDry run complete. Live tools need SEND21_API_KEY and at least one approved address.")


def tools_only(amount: float, currency: str, order_id: str) -> None:
    api_key = _api_key()
    if not api_key:
        raise SystemExit("Set SEND21_API_KEY (drafts:write, drafts:read). The key cannot move funds.")
    opts = receive_options()
    created = create_payment_request(
        api_key,
        {
            "fiatCurrency": currency,
            "fiatAmount": amount,
            "orderId": order_id,
            "reuseOpenForOrder": True,
            "options": opts,
        },
        idempotency_key=f"{order_id}-{uuid4()}",
    )
    print(json.dumps(created, indent=2, default=str))
    if created.get("id"):
        print("--- status ---")
        print(json.dumps(get_payment_request(api_key, created["id"]), indent=2, default=str))
    print(
        "\nA person opens the pay link and signs and sends from their own wallet. "
        "Prefer the signed draft.confirmed webhook over polling for production."
    )


async def run_agent(prompt: str) -> None:
    from agno.agent import Agent
    from agno.tools.mcp import MCPTools, StreamableHTTPClientParams

    api_key = _api_key()
    if not api_key:
        raise SystemExit("Set SEND21_API_KEY (drafts:write, drafts:read). The key cannot move funds.")
    opts = receive_options()
    model_id = os.environ.get("SEND21_MODEL", "openai:gpt-4.1-mini")
    instructions = (
        SYSTEM_PROMPT
        + "\n\nApproved receiving options (do not change the addresses):\n"
        + json.dumps(opts)
    )
    params = StreamableHTTPClientParams(
        url=MCP_URL,
        headers={"Authorization": f"Bearer {api_key}"},
    )
    async with MCPTools(server_params=params, transport="streamable-http") as mcp_tools:
        # Model is loaded lazily from the SEND21_MODEL / OPENAI_API_KEY environment.
        agent_kwargs = {"tools": [mcp_tools], "instructions": instructions, "markdown": True}
        try:
            from agno.models.openai import OpenAIChat

            agent = Agent(model=OpenAIChat(id=model_id.split(":", 1)[-1]), **agent_kwargs)
        except Exception:
            agent = Agent(**agent_kwargs)
        await agent.aprint_response(input=prompt, stream=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare a send21 pay link with Agno over MCP.")
    parser.add_argument("prompt", nargs="*", help="Prompt for the agent (default: a 25 EUR pay link).")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--tools-only", action="store_true")
    parser.add_argument("--amount", type=float, default=25)
    parser.add_argument("--currency", default="EUR")
    parser.add_argument("--order-id", default="inv-1042")
    args = parser.parse_args()
    if args.dry_run:
        asyncio.run(dry_run())
        return
    if args.tools_only:
        tools_only(args.amount, args.currency, args.order_id)
        return
    prompt = " ".join(args.prompt) or (
        f"Create a pay link for {args.amount} {args.currency} for order {args.order_id}, "
        "then tell me the link and that a person must sign and send from their own wallet."
    )
    asyncio.run(run_agent(prompt))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
