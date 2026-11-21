# Agno + send21 MCP

An [Agno](https://docs.agno.com/) agent that connects to the remote send21 MCP server at `https://send21.io/mcp` over Streamable HTTP, creates a pay link or a payment draft, and reads its status.

**The agent only prepares the payment.** send21 never holds keys or funds, never signs and never broadcasts. The scoped API key cannot move money. A person opens the pay link (or the draft) and signs and sends from their own wallet. This is not spend control: there is nothing the key can spend.

## Setup

Python 3.10 or newer.

```sh
cd examples/agno
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m unittest discover -s tests -v
```

Approve receiving addresses in send21 first (passkey or authenticator code). Account keys use the live networks; https://send21.io/demo is the testnet demo and needs no key.

## Run

```sh
# 1. No key needed: prints the planned create_payment_request arguments. Nothing is created.
python agent.py --dry-run

# 2. With a send21 key: creates a 25 EUR pay link over the REST API and reads its status, no model involved.
export SEND21_API_KEY=s21_...
export MY_SOLANA_ADDRESS=<your-solana-address>
python agent.py --tools-only --amount 25 --currency EUR --order-id inv-1042

# 3. The agent: Agno uses MCPTools(transport="streamable-http") against https://send21.io/mcp.
export OPENAI_API_KEY=...
python agent.py "Create a pay link for 40 EUR for order inv-1042."
```

For production, wait for a verified `draft.confirmed` webhook rather than polling status; see [webhook-receiver](../webhook-receiver).

Docs: https://send21.io/docs/mcp · Questions: info@send21.io
