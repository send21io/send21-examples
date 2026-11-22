# odoo-web3 adapter for send21

An adapter between [send21](https://send21.io/) and [odoo-web3](https://github.com/opencollective/odoo-web3), the open-source app that syncs on-chain token transfers into Odoo bank journals, enriches them (with Monerium SEPA data) and reconciles them with invoices.

It plugs send21 into odoo-web3's pipeline in two places:

1. **Customer invoices → pay links, then enrichment.** A posted customer invoice gets a send21 pay link (posted to the invoice's chatter). The customer signs and sends from their own wallet straight to your wallet. When the signed `draft.confirmed` webhook arrives, the adapter finds the statement line odoo-web3 imported for that transaction and writes `partner_id`, `payment_ref` (the invoice number) and `transaction_details`, exactly like odoo-web3's Monerium enrichment step ([docs/odoo/sync.md](https://github.com/opencollective/odoo-web3/blob/main/docs/odoo/sync.md)). odoo-web3's own reconciliation ("reference + amount") then matches the invoice.
2. **Vendor bills → send21 drafts, no private key on the server.** odoo-web3 can sign payments on the server with an encrypted private key. This adapter offers another way: it turns a posted vendor bill into a send21 draft (`POST /api/v1/drafts`), and a person signs and sends it from their own wallet, or proposes it to the Safe. The API key can prepare drafts; no key can move funds, and send21 never holds keys or funds. When the transfer confirms, the outgoing statement line is enriched with the bill number the same way.

The adapter never creates statement lines itself. odoo-web3 stays the one importer (its dedupe key `chain:wallet:txHash:logIndex` in `unique_import_id`), so nothing is imported twice.

## What to configure in odoo-web3

odoo-web3 syncs ERC-20 transfers from an Etherscan-compatible explorer and its default setup is EURe on Gnosis. send21 does not support Gnosis or EURe. To use both together, point an odoo-web3 journal at a wallet and token send21 supports: **USDC, USDT or EURC on Ethereum, Base, Arbitrum or Polygon** (for example EURC on Base). The adapter only accepts those receiving options.

## How it works

- **Pay link:** `POST /api/v1/payment-requests` for the invoice's residual amount and currency, `orderId: "odoo-web3-move-<id>"`, `reuseOpenForOrder: true`, an `Idempotency-Key` of order id plus amount, your receiving options, and an optional `declineNote` (plain text, max 200 characters, shown on the pay page as "If you don't pay:"). The adapter stores what the link asked for.
- **Bill draft:** `POST /api/v1/drafts` with the vendor's 0x address, network and token, `paymentMethod: "MultiOutput"`, `singleOutput: true` (one QR payment from any wallet), fiat amount and currency, and an `Idempotency-Key` per bill and amount. The vendor address must be one you approved in send21 (new accounts only pay approved addresses).
- **Webhook** (`POST /send21/webhook`):
  - checks `X-Send21-Signature-V2` on the raw body (HMAC-SHA256 of `<timestamp>.<X-Send21-Delivery>.<raw body>`, constant time, refused when more than 5 minutes old) and answers 401 otherwise, before reading anything,
  - skips delivery ids it has already handled (retries reuse `X-Send21-Delivery`, and send21 does not dedupe); ids are recorded after acting,
  - enriches only on `draft.confirmed` that matches the stored pay link or bill draft (pay link id, currency, amount), and only lines without a partner, as odoo-web3 does,
  - if odoo-web3 has not synced the transfer yet, keeps it pending; run `cli.ts enrich-pending` after the next sync (or on a timer).
- Differing amounts (`draft.amount_mismatch` and the related events) are left for you: accept or decline the transfer in send21. **Refunds are manual**, from your own wallet: crypto payments cannot be pulled back.

## Run

Works with Bun (as odoo-web3 does) or Node.js 22.18+, no dependencies.

```sh
cp .env.example .env        # send21 key and webhook secret, the same Odoo settings as odoo-web3, the journal id
bun server.ts               # or: npm start
bun cli.ts pay-link 42
bun cli.ts bill-draft 77 0xVendorAddress Base Usdc
bun cli.ts enrich-pending
```

Create the send21 API key with `drafts:read` and `drafts:write`. Register the webhook with a key that has `webhooks:manage` and keep the signing secret it returns once:

```sh
curl -X POST https://send21.io/api/v1/webhooks \
  -H "Authorization: Bearer $SEND21_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://books.example.com/send21/webhook","events":["draft.confirmed","draft.amount_mismatch","draft.mismatch_reminder","draft.mismatch_unresolved"]}'
```

Account keys use the live networks. To try the payer side without an account or money, use the testnet demo at https://send21.io/demo.

## Tests

Offline, with a fake Odoo JSON-RPC and fake HTTP:

```sh
cd examples/odoo-web3-adapter
npm test
```

They cover all three odoo-web3 import id formats, the request bodies, the signature window, enrichment like the Monerium step, pending lines, lines that already have a partner, differing amounts, bill drafts and repeated deliveries.

Webhook reference: https://send21.io/docs/webhooks · API: https://send21.io/swagger · Fees: https://send21.io/pricing

MIT licensed. Questions: info@send21.io
