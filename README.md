# send21 examples

send21 is non-custodial software that prepares payment instructions, payment drafts and pay links, for BTC (on-chain and over Lightning), USDC, USDT, EURC, SOL and ETH. An agent or app creates them through the REST API or the MCP server, and a human signs the payment in their own wallet. send21 never holds keys or funds, never signs and never broadcasts.

**Agent proposes, human signs.**

- Testnet demo, no account and no email: https://send21.io/demo (on send21.io the test networks are for this demo only; account drafts and API keys use the live networks)
- API docs: https://send21.io/swagger
- Webhook guide (events, example payloads, delivery headers, retries, signature check): the Webhooks section at https://send21.io/swagger
- MCP server (Streamable HTTP): https://send21.io/mcp
- Machine-readable overview: https://send21.io/llms.txt
- Fees: https://send21.io/pricing

## Examples

| Folder | What it does |
|---|---|
| [examples/mcp-payment-request](examples/mcp-payment-request) | An agent-side TypeScript script that connects to the send21 MCP server and creates a payment request (pay link) for an amount and fiat currency, then prints the link. Includes MCP client config for Cursor and Claude Desktop. |
| [examples/webhook-receiver](examples/webhook-receiver) | A small Node.js server with no dependencies that verifies the `X-Send21-Signature` HMAC, ignores repeated deliveries by `X-Send21-Delivery` and handles `draft.confirmed` and `draft.amount_mismatch`. Comes with tests that use the documented example payload. |

## Supported currencies and networks

- BTC on Bitcoin, on-chain.
- BTC over Lightning, paid to the receiver's own Lightning address (like name@wallet.com). send21 fetches an invoice for the exact amount and confirms the payment automatically when the receiver's wallet provider supports LUD-21.
- USDC on Solana, Ethereum, Base, Arbitrum and Polygon. On Arbitrum and Polygon only native USDC, not the bridged USDC.e.
- USDT on Solana and Ethereum.
- EURC on Solana, Ethereum and Base.
- SOL, native, on Solana.
- ETH, native, on Ethereum, Base and Arbitrum.
- Wrapped BTC on Solana and Ethereum.
- Prices in 165 fiat currencies.

The testnet demo covers Bitcoin, Solana, Ethereum, Base, Arbitrum and Polygon test networks. On send21.io the test networks are reserved for the demo, so drafts made with your own API key use the live networks.

## Setup

You need Node.js 20.12 or newer.

```sh
cp .env.example .env
```

Calls that create something need an API key. The account owner creates scoped keys at https://send21.io/api-keys. `tools/list` and `get_fee_schedule` on the MCP server work without a key.

Testing with your own key: use the live networks and create a small draft to your own address. A draft moves no money until someone signs it, so nothing moves while you integrate. Cancel it when you are done.

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

The script prints a pay link like `https://send21.io/pay/...`. The payer opens it, picks a currency (the exchange rate locks at that point), scans one QR code and signs in their own wallet. The funds go straight from the payer's wallet to your address. The script passes an idempotency key, so a retry with the same key returns the original request.

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

The server offers `create_payment_request`, `get_payment_request`, `create_draft`, `get_draft`, `get_draft_status`, `get_transaction_template`, `list_address_book`, `get_rate` and `get_fee_schedule`.

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
| `X-Send21-Signature` | `sha256=` followed by the lowercase hex HMAC-SHA256 of the raw body, keyed with your signing secret. |

Any 2xx response counts as delivered. Anything else, or no answer within 15 seconds, is retried after 1, 2, 4, 8 minutes and so on, up to 8 attempts. Deliveries can arrive out of order. The guide defines no timestamp header, so there is no timestamp window to check. Repeated deliveries are recognized by `X-Send21-Delivery`.

The receiver:

- verifies the signature over the exact bytes received, with a constant-time compare, and answers 401 if it does not match (a missing or malformed header returns 401, it does not throw),
- answers 200 without handling the event again when it has already handled that `X-Send21-Delivery` id (kept in memory here, use your database in production),
- on `draft.confirmed`, logs the order id, amount, currency, network and txid. This is the only place where you mark the order paid. When `receivedAmountSats` or `receivedAmount` is present, the owner accepted a different amount, and it logs `paid (different amount accepted)` with the received and billed amounts,
- on `draft.amount_mismatch`, logs the received and billed amounts, flags the payment for review and does not mark it paid. The receiver decides: accept it as paid in the send21 app or with `POST /api/v1/drafts/{id}/accept-received`,
- on `draft.seen`, logs it and does not mark the order paid. It is also sent with `acceptedByOwner: true` when the owner accepts a payment with a different amount. In both cases `draft.confirmed` follows once the transfer has the required confirmations,
- answers 200 for `test` and ignores the other events (`draft.created`, `draft.expired`, `draft.cancelled`).

Keep your handler idempotent by keying your records on `draftId` and `orderId`, answer fast and do slow work after replying, and never move an order backwards when an older event arrives late.

The `draft.amount_mismatch` sample in [samples.js](examples/webhook-receiver/samples.js) is the example payload from the webhook guide, byte for byte. The `draft.confirmed-accepted` sample is derived from the docs, not copied from them: the guide says `receivedAmountSats` and `receivedAmount` are set on the `draft.confirmed` of an accepted short or over payment, so it is a normal `draft.confirmed` with those two fields added. Amounts ending in `Sats` are base units of the sent asset: 8 decimals for BTC, 6 for USDC, USDT and EURC, 9 for SOL and ETH (gwei).

## What send21 does not do

- Agents cannot sign or pay on their own through send21. A human or the operator's own wallet signs. send21 is not an agent wallet.
- Lightning payments are confirmed automatically only when the receiver's wallet provider supports LUD-21. A pasted invoice is never confirmed automatically.
- No USDT on Tron, Arbitrum or Polygon, and nothing on BNB Chain. No ETH on Polygon.
- On Base and Arbitrum, several ETH payments to the same address at the same time may not be told apart. Keep one open ETH payment per address there.
- No app in the Shopify App Store. A merchant connects a store with their own custom Shopify app.
- A payment with a different amount is not confirmed automatically. The receiver decides. Transfers more than 10% off, or ones that could belong to several open payments, are not flagged.
- No payouts to bank accounts and no conversion to fiat.

## Help

Integration questions: integration@send21.io

## License

[MIT](LICENSE)
