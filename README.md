# send21 examples

send21 is non-custodial software that prepares payment instructions, payment drafts and pay links, for BTC, USDC, USDT and EURC. An agent or app creates them through the REST API or the MCP server, and a human signs the payment in their own wallet. send21 never holds keys or funds, never signs and never broadcasts.

**Agent proposes, human signs.**

- Testnet demo, no account and no email: https://send21.io/demo
- API docs: https://send21.io/swagger
- MCP server (Streamable HTTP): https://send21.io/mcp
- Machine-readable overview: https://send21.io/llms.txt
- Fees: https://send21.io/pricing

## Examples

| Folder | What it does |
|---|---|
| [examples/mcp-payment-request](examples/mcp-payment-request) | An agent-side TypeScript script that connects to the send21 MCP server and creates a payment request (pay link) for an amount and fiat currency, then prints the link. Includes MCP client config for Cursor and Claude Desktop. |
| [examples/webhook-receiver](examples/webhook-receiver) | A small Node.js server with no dependencies that verifies the `X-Send21-Signature` HMAC and handles `draft.confirmed` and `draft.amount_mismatch`. Comes with tests. |

## Setup

You need Node.js 20.12 or newer.

```sh
cp .env.example .env
```

Calls that create something need an API key. The account owner creates scoped keys at https://send21.io/api-keys. `tools/list` and `get_fee_schedule` on the MCP server work without a key.

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
  --memo "Invoice 1042" --order-id inv-1042
```

Each `--option` is `Currency:Network:Address`, where the address is your own receiving address. Currencies are `Btc`, `Usdc`, `Usdt` and `Eurc`. Networks for payment requests are `Mainnet` (Bitcoin), `Solana`, `Ethereum` and `Base`. USDC and EURC are on Solana, Ethereum and Base. USDT is on Solana and Ethereum.

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
npm run send-sample -- draft.amount_mismatch
```

Register the endpoint at https://send21.io/webhooks, or with `POST /api/v1/webhooks` and a key with the `webhooks:manage` scope. The webhook secret is shown once when you create the endpoint. Put it in `SEND21_WEBHOOK_SECRET`.

Every delivery carries `X-Send21-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw request body keyed with your webhook secret. The receiver:

- verifies the signature over the exact bytes received, with a constant-time compare, and answers 401 if it does not match,
- on `draft.confirmed`, logs the order id, amount, currency, network and txid. This is where you mark the order paid,
- on `draft.amount_mismatch`, flags the payment for review and does not mark it paid. The receiver decides: accept it as paid in the send21 app or with `POST /api/v1/drafts/{id}/accept-received`,
- answers 200 and ignores other events (`draft.created`, `draft.seen`, `draft.expired`, `draft.cancelled`).

Keep your handler idempotent by keying your records on `draftId` and `orderId`. The payload fields for `draft.amount_mismatch` are not documented yet, so this example logs the whole `data` object.

## What send21 does not do

- Agents cannot sign or pay on their own through send21. A human or the operator's own wallet signs. send21 is not an agent wallet.
- No automatic Lightning confirmation. BTC on Lightning works only as a receiver-supplied invoice.
- A payment with a different amount is not confirmed automatically. The receiver decides. Transfers more than 10% off, or ones that could belong to several open payments, are not flagged.
- No payouts to bank accounts and no conversion to fiat.

## Help

Integration questions: integration@send21.io

## License

[MIT](LICENSE)
