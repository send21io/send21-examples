<p align="center"><img src="https://raw.githubusercontent.com/send21io/send21io/main/assets/social-1280x640.png" alt="send21" width="640"></p>

# send21 examples

send21: crypto pay links and API for people and AI agents. It is non-custodial software that prepares payment instructions, payment drafts and pay links, for BTC (on-chain and over Lightning), USDC, USDT, EURC, SOL and ETH. An agent or app creates them through the REST API or the MCP server, and a human signs the payment in their own wallet. send21 never holds keys or funds, never signs and never broadcasts.

**Agent proposes, human signs.**

- Testnet demo, no account and no email: https://send21.io/demo (on send21.io the test networks are for this demo only; account drafts and API keys use the live networks)
- API docs: https://send21.io/swagger
- Webhook guide (events, example payloads, delivery headers, retries, signature check): the Webhooks section at https://send21.io/swagger
- MCP server (Streamable HTTP): https://send21.io/mcp
- Machine-readable overview: https://send21.io/llms.txt
- Fees: https://send21.io/pricing

## Templates

Copy-paste setups for common tools:

| Folder | What it is |
|---|---|
| [claude-desktop](claude-desktop) | `claude_desktop_config.json` snippet, 3-step quickstart that ends with a working pay link, and a sample prompt. |
| [cursor](cursor) | `.cursor/mcp.json` snippet, quickstart and a sample prompt. |
| [n8n](n8n) | Importable workflow: create a pay link with `POST /api/v1/payment-requests`, register a webhook, and receive and verify the `draft.confirmed` confirmation. |

## Examples

| Folder | What it does |
|---|---|
| [examples/mcp-payment-request](examples/mcp-payment-request) | An agent-side TypeScript script that connects to the send21 MCP server and creates a payment request (pay link) for an amount and fiat currency, then prints the link. Includes MCP client config for Cursor and Claude Desktop. |
| [examples/mastra](examples/mastra) | A minimal [Mastra](https://mastra.ai) agent that connects to the remote send21 MCP server with `MCPClient`, creates a pay link with receiving addresses fixed in code and reads its status. Includes a dry run that needs no key. |
| [examples/shopify-app](examples/shopify-app) | Reference code that connects a Shopify store to send21 without payments-partner approval. The buyer checks out with a manual payment method and gets a send21 pay link; when `draft.confirmed` arrives (`X-Send21-Signature-V2` verified), the app marks the Shopify order paid. Node.js, no npm dependencies. Each merchant runs it as their own custom Shopify app. |
| [examples/checkout-component](examples/checkout-component) | A framework-agnostic webshop checkout: a drop-in `<send21-checkout>` web component (one ES module, no build step, optional React wrapper, themeable, send21 colors by default) and a minimal Node.js shop backend. The backend creates the pay link with the scoped key and receive addresses fixed server-side (`Idempotency-Key`, `reuseOpenForOrder`), serves a status endpoint the component polls, and marks the order paid on a V2-verified `draft.confirmed` only when the amount, currency and asset match the order. Includes a demo shop with a DRY_RUN mock mode that needs no key, and tests. |
| [examples/webhook-receiver](examples/webhook-receiver) | A small Node.js server with no dependencies that verifies the `X-Send21-Signature-V2` HMAC (timestamp + delivery id + raw body, 5-minute window; legacy `X-Send21-Signature` only as fallback), ignores repeated deliveries by `X-Send21-Delivery` and handles `draft.confirmed`, `draft.amount_mismatch` and the review events `draft.mismatch_accepted`, `draft.mismatch_rejected`, `draft.mismatch_reminder` and `draft.mismatch_unresolved`. Comes with tests that use the documented example payload. |
| [examples/webhook-receiver-sqlite](examples/webhook-receiver-sqlite) | The same receiver with a durable delivery-id store in SQLite (`node:sqlite`, no server, no dependency): the `X-Send21-Delivery` id and the order update are committed in one transaction before the 2xx answer, so a restart, a lost ack or a crash before commit never applies an update twice or loses it. Tests kill and restart the process to show it. |

## Integrations

For agents built in code rather than connected over MCP, send21 also comes as framework packages:

| Folder | Install | Package |
|---|---|---|
| [integrations/langchain](integrations/langchain) | `pip install langchain-send21` | [PyPI](https://pypi.org/project/langchain-send21/) |
| [integrations/vercel-ai-sdk](integrations/vercel-ai-sdk) | `npm install ai-sdk-tool-send21 ai zod` | [npm](https://www.npmjs.com/package/ai-sdk-tool-send21) |
| [send21io/send21-haystack](https://github.com/send21io/send21-haystack) | `pip install send21-haystack` | [PyPI](https://pypi.org/project/send21-haystack/) |

## Apps

| Folder | What it is |
|---|---|
| [apps/send21-pair](apps/send21-pair) | **TESTNET prototype** of peer-to-peer payments: two people pair by scanning a QR code or opening a link, then request and pay each other in their own currency (split a bill, pay back a friend, a QR anyone can pay at a market stall). Each payment is a draft to the receiver's own address; the payer taps the notification, taps *Open wallet* (BIP-21, Solana Pay or EIP-681 deep link) and signs in their own wallet. Installable PWA with Web Push (VAPID) and a Node.js backend with no dependencies (`node:sqlite`): `X-Send21-Signature-V2` verification, durable dedupe on `X-Send21-Delivery`, amount and asset checked against the stored request. Mock mode runs without a key; [try it in the browser](https://send21io.github.io/send21-examples/pair/). Design notes in [DESIGN.md](apps/send21-pair/DESIGN.md). |
| [apps/dewby](apps/dewby) | **TESTNET white-label example** built on send21: *dewby*, a fresh, light P2P money app (request, pay, split, a QR anyone can pay, friends, status chips) with its own name, logo, palette and rounded type. The UI is new; the server and payment logic are send21 pair's, imported unchanged (receiver address fixed server-side, `Idempotency-Key`, `X-Send21-Signature-V2`, SQLite dedupe, mismatch handling), and pair's whole test suite runs against it. Rebrand it by editing one file, `web/brand.js`. [Try it in the browser](https://send21io.github.io/send21-examples/dewby/). |

## Supported currencies and networks

- BTC on Bitcoin, on-chain.
- BTC over Lightning, paid to the receiver's own Lightning address (like name@wallet.com). send21 fetches an invoice for the exact amount and confirms the payment automatically when the receiver's wallet provider supports LUD-21.
- USDC on Solana, Ethereum, Base, Arbitrum and Polygon. On Arbitrum and Polygon only native USDC, not the bridged USDC.e.
- USDT on Solana and Ethereum.
- EURC on Solana, Ethereum and Base.
- SOL, native, on Solana.
- ETH, native, on Ethereum, Base and Arbitrum.
- Wrapped BTC on Solana and Ethereum.
- Prices in 161 fiat currencies.

The testnet demo covers Bitcoin, Solana, Ethereum, Base, Arbitrum and Polygon test networks. On send21.io the test networks are reserved for the demo, so drafts made with your own API key use the live networks.

## Setup

You need Node.js 20.12 or newer. The P2P apps ([apps/send21-pair](apps/send21-pair), [apps/dewby](apps/dewby)) and [examples/webhook-receiver-sqlite](examples/webhook-receiver-sqlite) use `node:sqlite`, so they need **Node.js 22.5 or newer**.

```sh
cp .env.example .env
```

Calls that create something need an API key or OAuth sign-in. The account owner creates scoped keys at https://send21.io/api-keys. Clients that support MCP sign-in (OAuth), such as Claude, Claude Code, Cursor, VS Code and Muse Code, can use `https://send21.io/mcp/oauth` with no headers instead: you sign in to send21 in the browser and approve the app, no key to copy. Connected apps only ever use receiving addresses the owner approved. See [Sign in instead of an API key](#sign-in-instead-of-an-api-key). `tools/list` and `get_fee_schedule` on the MCP server work without a key.

**Approve your receiving addresses first.** New send21 accounts (created on or after 20 Oct 2026) only accept receiving addresses the owner approved, Lightning addresses included. Add them in the send21 app, or let an agent propose them with MCP `propose_receiving_address`, then sign in and approve each with a passkey or authenticator code. No API key can approve an address. Older accounts can opt in under Settings.

Testing with your own key: use the live networks and create a small draft to your own address. A draft moves no money until someone signs it, so nothing moves while you integrate. Cancel it when you are done.

## Sign in instead of an API key

Clients that support MCP sign-in (OAuth) can connect to `https://send21.io/mcp/oauth` with no key and no headers. The client opens send21 in your browser; you sign in, see what the app asks for, and approve. A connected app only ever uses receiving addresses you approved. It is listed under [API keys](https://send21.io/api-keys) as a connected app, where Disconnect ends it at once, and a connection nobody uses for 90 days ends by itself.

**Claude Code**

```bash
claude mcp add --transport http send21 https://send21.io/mcp/oauth
# then run /mcp in Claude Code and choose send21 to sign in
# (or, from your shell: claude mcp login send21)
```

**Cursor** (`.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for all projects)

```json
{
  "mcpServers": {
    "send21": {
      "url": "https://send21.io/mcp/oauth"
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`)

```json
{
  "servers": {
    "send21": {
      "type": "http",
      "url": "https://send21.io/mcp/oauth"
    }
  }
}
```

**Any MCP client that supports OAuth:** add `https://send21.io/mcp/oauth` as a remote (Streamable HTTP) MCP server with no headers, then sign in when the client asks.

Prefer an API key? It still works: use `https://send21.io/mcp` with `Authorization: Bearer s21_...`, a scoped key created at https://send21.io/api-keys. `tools/list` and `get_fee_schedule` work without either. Details: https://send21.io/docs/mcp

## mcp-payment-request

```sh
cd examples/mcp-payment-request
npm install

# No key needed: connects, lists the live tools and checks your arguments
# against the live create_payment_request schema without creating anything.
npm run dry-run -- 25 EUR --option Usdc:Solana:<your-solana-address>

# With SEND21_API_KEY set (scope drafts:write): creates the pay link.
npm start -- 25 EUR \
  --option Usdc:Solana:<your-solana-address> \
  --option Eurc:Base:<your-base-address> \
  --option Eth:Base:<your-base-address> \
  --option Btc:Mainnet:name@wallet.com:Lightning \
  --memo "Invoice 1042" --order-id inv-1042
```

Each `--option` is `Currency:Network:Address[:Method]`, using the values from the live `create_payment_request` schema:

- `Currency`: `Btc`, `Usdc`, `Usdt`, `Eurc`, `Sol` or `Eth`.
- `Network`: `Mainnet` (Bitcoin), `Solana`, `Ethereum`, `Base`, `Arbitrum` or `Polygon`.
- `Address`: your own receiving address. For Lightning, your Lightning address (like name@wallet.com).
- `Method` (optional): `MultiOutput` (on-chain, the default) or `Lightning` (only for `Btc` on `Mainnet`).

More examples:

| Option | Payer pays with |
|---|---|
| `Btc:Mainnet:<your-bitcoin-address>` | BTC on-chain |
| `Btc:Mainnet:name@wallet.com:Lightning` | BTC over Lightning, to your Lightning address |
| `Sol:Solana:<your-solana-address>` | SOL on Solana |
| `Eth:Ethereum:<your-ethereum-address>` | ETH on Ethereum |
| `Eth:Base:<your-base-address>` | ETH on Base |
| `Eth:Arbitrum:<your-arbitrum-address>` | ETH on Arbitrum |
| `Usdc:Arbitrum:<your-arbitrum-address>` | native USDC on Arbitrum |
| `Usdc:Polygon:<your-polygon-address>` | native USDC on Polygon |

Use only the combinations in the list of supported currencies and networks above. The dry run checks your arguments against the live schema without creating anything.

The script prints a pay link like `https://send21.io/pay/...`. The payer opens it, picks a currency (the exchange rate locks at that point), scans one QR code and signs in their own wallet. The funds go straight from the payer's wallet to your address. The script passes an idempotency key, so a retry with the same key returns the original request. An `Idempotency-Key` reused with a different amount, currency or address is refused with 422 and nothing is created, so use a new key for each new payment and reuse a key only to retry the exact same request.

### Add the send21 MCP server to your client

Cursor, in `.cursor/mcp.json` or `~/.cursor/mcp.json` ([file](examples/mcp-payment-request/client-config/cursor-mcp.json)):

```json
{
  "mcpServers": {
    "send21": {
      "url": "https://send21.io/mcp",
      "headers": {
        "Authorization": "Bearer ${env:SEND21_API_KEY}"
      }
    }
  }
}
```

Claude Desktop, in `claude_desktop_config.json`, through the `mcp-remote` bridge ([file](examples/mcp-payment-request/client-config/claude_desktop_config.json)):

```json
{
  "mcpServers": {
    "send21": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://send21.io/mcp", "--header", "Authorization:${SEND21_AUTH_HEADER}"],
      "env": {
        "SEND21_AUTH_HEADER": "Bearer s21_your_key_here"
      }
    }
  }
}
```

The server offers `create_payment_request`, `get_payment_request`, `create_draft`, `get_draft`, `get_draft_status`, `list_draft_quotes`, `get_transaction_template`, `submit_lightning_proof`, `list_address_book`, `propose_receiving_address`, `get_account_status`, `create_account`, `get_rate` and `get_fee_schedule`.

### Agent flow: approved addresses

**Agents onboard themselves; humans approve where the money lands.**

1. `get_account_status`: what still stands between the agent and a live pay link (owner confirmed, receiving-address policy, approved and waiting addresses, fees, next steps).
2. `propose_receiving_address`: the agent proposes the owner's receiving address (`label`, `address`, `network`). It is saved unapproved and the owner gets an email.
3. **The owner approves it**, signed in to send21 with a passkey or authenticator code. No API key, scope or agent can approve an address.
4. `create_payment_request` with approved addresses only. Any other address gets 422 `address_not_approved` and nothing is created.

No key yet? The agent can call `create_account` (`POST /api/v1/accounts/agent-signup`) with the owner's email and gets a limited bootstrap key. Until the owner takes the account over from the emailed link, creating anything returns 403 `owner_not_confirmed`. The agent never approves addresses, spends or signs: the payer signs in their own wallet. Details: https://send21.io/docs/mcp

## webhook-receiver

```sh
cd examples/webhook-receiver
npm test                                  # unit and HTTP tests, no network needed
npm start                                 # listens on http://localhost:3000/webhooks/send21
npm run send-sample -- draft.confirmed    # in a second terminal, posts a locally signed sample
npm run send-sample -- draft.confirmed-accepted
npm run send-sample -- draft.amount_mismatch
npm run send-sample -- test
```

Register the endpoint at https://send21.io/webhooks, or with `POST /api/v1/webhooks` and a key with the `webhooks:manage` scope. The signing secret is returned once when you create the endpoint. Put it in `SEND21_WEBHOOK_SECRET`.

For a real signed delivery from send21, call `POST /api/v1/webhooks/{id}/test`. The delivery carries the `test` event.

The full webhook guide is in the Webhooks section at https://send21.io/swagger. Each delivery is a `POST` with `Content-Type: application/json`, a body of `{"event": "<type>", "data": {...}}` and these headers:

| Header | Meaning |
|---|---|
| `X-Send21-Event` | The event type, same as `event` in the body. |
| `X-Send21-Delivery` | Unique delivery id. Retries reuse it. |
| `X-Send21-Signature-V2` | Verify this one: `t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<delivery id>.<raw body>">`, keyed with your signing secret. It also signs the time and delivery id, so a copied delivery cannot be replayed. Refuse deliveries older than 5 minutes. |
| `X-Send21-Timestamp` | When the delivery was sent, in Unix seconds (the same value as `t=` in the V2 header). |
| `X-Send21-Signature` | Legacy, still sent for compatibility: `sha256=` followed by the lowercase hex HMAC-SHA256 of the raw body only (no timestamp, no delivery id). Use it only as a fallback when no V2 header is present. |

Any 2xx response counts as delivered. Anything else, or no answer within 15 seconds, is retried after 1, 2, 4, 8 minutes and so on, up to 8 attempts. Deliveries can arrive out of order. With `X-Send21-Signature-V2`, refuse deliveries older than 5 minutes. Both this Node.js receiver and the [n8n template](n8n) verify V2 first and fall back to the legacy header only when no V2 header is sent. Repeated deliveries are recognized by `X-Send21-Delivery`.

The receiver:

- verifies `X-Send21-Signature-V2` over `"<timestamp>.<delivery id>.<raw body>"` (the exact bytes received), with a constant-time compare, and refuses deliveries more than 5 minutes old; only when no V2 header is sent does it fall back to the legacy body-only `X-Send21-Signature` (turn that off with `allowLegacy: false`). It answers 401 on a missing, expired or wrong signature (a malformed header returns 401, it does not throw),
- answers 200 without handling the event again when it has already handled that `X-Send21-Delivery` id (kept in memory here, so it is forgotten on restart; [webhook-receiver-sqlite](examples/webhook-receiver-sqlite) keeps it in SQLite, committed in the same transaction as the order update),
- on `draft.confirmed`, logs the order id, amount, currency, network and txid. This is the only place where you mark the order paid. When `receivedAmountSats` or `receivedAmount` is present, the owner accepted a different amount, and it logs `paid (different amount accepted)` with the received and billed amounts,
- on `draft.amount_mismatch`, logs the received and billed amounts, flags the payment for review and does not mark it paid. The receiver decides: accept it as paid in the send21 app or with `POST /api/v1/drafts/{id}/accept-received`,
- on `draft.seen`, logs it and does not mark the order paid. It is also sent with `acceptedByOwner: true` when the owner accepts a payment with a different amount. In both cases `draft.confirmed` follows once the transfer has the required confirmations,
- on `draft.mismatch_accepted`, logs the `acceptReason` (set by the receiver, or `auto: shortfallPolicy`); the order is marked paid on the `draft.confirmed` that follows,
- on `draft.mismatch_rejected`, logs the `rejectReason` and does not mark the order paid. The money is already in the receiver's wallet (`refund: "manual"`); send21 never holds or returns funds,
- on `draft.mismatch_reminder` (still undecided 2 hours before expiry) and `draft.mismatch_unresolved` (the draft expired or was cancelled while the transfer was undecided: money arrived, nobody decided, it can still be accepted), keeps the payment on the review list,
- answers 200 for `test` and ignores the other events (`draft.created`, `draft.expired`, `draft.cancelled`, `payment_request.expired`).

Keep your handler idempotent by keying your records on `draftId` and `orderId`, answer fast and do slow work after replying, and never move an order backwards when an older event arrives late.

The `draft.amount_mismatch` sample in [samples.js](examples/webhook-receiver/samples.js) is the example payload from the webhook guide, byte for byte. The `draft.confirmed-accepted` sample is derived from the docs, not copied from them: the guide says `receivedAmountSats` and `receivedAmount` are set on the `draft.confirmed` of an accepted short or over payment, so it is a normal `draft.confirmed` with those two fields added. Amounts ending in `Sats` are base units of the sent asset: 8 decimals for BTC, 6 for USDC, USDT and EURC, 9 for SOL and ETH (gwei).

## Third-party examples

- [PriorSeal: send21 payment draft binding](https://github.com/imokokok/PriorSeal/tree/main/examples/send21-payment-draft-binding-v1), built by the PriorSeal team. It hashes a send21 draft (JCS + SHA-256) into a signed authorization receipt, so a reviewer can follow draft, then payer signature, then on-chain payment as one checkable chain. Base Sepolia testnet only. Independent project, not maintained by send21.

## Troubleshooting

- **422 `address_not_approved`:** a receiving address isn't approved in your send21 account, so nothing was created. Sign in to send21, approve it (passkey or authenticator code), then retry.
- **403 `owner_not_confirmed`:** an agent created the account (`create_account`) and the owner hasn't taken it over yet. The owner opens the emailed link (valid 72 hours) and sets up a passkey or password.

## What send21 does not do

- Agents cannot sign or pay on their own through send21. A human or the operator's own wallet signs. send21 is not an agent wallet.
- Lightning payments are confirmed automatically only when the receiver's wallet provider supports LUD-21. A pasted invoice is never confirmed automatically.
- No USDT on Tron, Arbitrum or Polygon, and nothing on BNB Chain. No ETH on Polygon.
- On Base and Arbitrum, several ETH payments to the same address at the same time may not be told apart. Keep one open ETH payment per address there.
- No app in the Shopify App Store. A merchant connects a store with their own custom Shopify app, for example the [Shopify reference code](examples/shopify-app).
- A payment with a different amount is not confirmed automatically. The receiver decides. Transfers more than 10% off, or ones that could belong to several open payments, are not flagged.
- No payouts to bank accounts and no conversion to fiat.

## Help

Integration questions: integration@send21.io

## License

[MIT](LICENSE)
