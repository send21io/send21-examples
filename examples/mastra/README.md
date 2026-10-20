# mastra

A minimal [Mastra](https://mastra.ai) agent that gets paid through send21. It connects to the remote send21 MCP server at `https://send21.io/mcp` with Mastra's `MCPClient` (`@mastra/mcp`), creates a pay link and reads its status.

**The agent never holds keys.** send21 only prepares payment instructions: it never holds keys or funds, never signs and never broadcasts. The scoped API key the agent uses can create a pay link but cannot move money. The payer opens the link, picks a currency, scans one QR code and signs in their own wallet, and the funds go straight to your address.

## Setup

Node.js 22.13 or newer (required by `@mastra/core`).

```sh
cd examples/mastra
npm install
npm run typecheck
```

Before a live run, approve `MY_SOLANA_ADDRESS`, `MY_BASE_ADDRESS` and `MY_LIGHTNING_ADDRESS` in send21: new accounts only accept receiving addresses the owner approved (sign in, passkey or authenticator code). Otherwise the tool explains 422 `address_not_approved` (or 403 `owner_not_confirmed` for an agent-created account the owner hasn't taken over) and nothing is created.

## Run

```sh
# 1. No key needed: connects, lists the live MCP tools and checks the planned
#    create_payment_request arguments against the live schema. Nothing is created.
npm run dry-run

# 2. With a send21 key: creates a 25 EUR pay link and reads its status, no LLM involved.
export SEND21_API_KEY=s21_...                 # scopes drafts:write, drafts:read
export MY_SOLANA_ADDRESS=<your-solana-address>
npm start -- --tools-only

# 3. The agent: the model decides when to call the tools.
export OPENAI_API_KEY=...                     # or another provider, see MODEL
npm start -- "Create a pay link for 40 EUR for order inv-1042, then check its status."
```

## Environment variables

| Variable | Needed for | Meaning |
|---|---|---|
| `SEND21_API_KEY` | `--tools-only`, agent | Scoped key from https://send21.io/api-keys with `drafts:write` and `drafts:read`. It cannot spend. |
| `MY_SOLANA_ADDRESS` | at least one of these three | Your own Solana address, offered as USDC on Solana. |
| `MY_BASE_ADDRESS` | | Your own Base address, offered as USDC on Base. |
| `MY_LIGHTNING_ADDRESS` | | Your own Lightning address (name@wallet.com), offered as BTC over Lightning. |
| `MODEL` | agent (optional) | Mastra model id, default `openai/gpt-5-mini`. Set the matching provider key, e.g. `OPENAI_API_KEY`. |

## How it works

- `MCPClient` connects to `https://send21.io/mcp` over Streamable HTTP with `Authorization: Bearer <key>`, and `allowedHosts: ["send21.io"]` keeps it from contacting anything else.
- The agent does not get the raw MCP tools. It gets two small tools, `create_pay_link` and `get_pay_link_status`, that call the MCP tools `create_payment_request` and `get_payment_request`. The receiving addresses come from your environment and are injected in code, so the model only chooses the amount, currency, order id and memo. A prompt injection cannot redirect the money to another address.
- Each create call sends a fresh `idempotencyKey`. With an `orderId` it also sets `reuseOpenForOrder: true`, so a retry returns the open link for that order instead of creating a second one.
- Status is `Open`, `Completed`, `Cancelled` or `Expired`, plus any "what changed" notes. For production, use the signed `draft.confirmed` webhook instead of polling; see [webhook-receiver](../webhook-receiver).

Supported: BTC on-chain and over Lightning, USDC on Solana, Ethereum, Base, Arbitrum and Polygon, USDT on Solana and Ethereum, EURC on Solana, Ethereum and Base, SOL, and ETH on Ethereum, Base and Arbitrum. Prices in 161 fiat currencies. Unsupported pairs are refused before anything is sent.

Testing with your own key uses the live networks. A pay link moves no money until someone pays it; cancel test links with `POST https://send21.io/api/v1/payment-requests/{id}/cancel`.

Docs: https://send21.io/docs/mcp. Questions: info@send21.io
