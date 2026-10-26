# send21 in n8n

An importable n8n workflow, [`send21-pay-link-workflow.json`](send21-pay-link-workflow.json), with three parts that use only the documented send21 REST API (https://send21.io/swagger):

1. **Register webhook (run once):** `POST /api/v1/webhooks` with your n8n webhook URL and the events `draft.confirmed`, `draft.amount_mismatch` and `payment_request.expired`.
2. **Create pay link:** `POST /api/v1/payment-requests` with an `Idempotency-Key` header, then builds the pay link `https://send21.io` + `payPath`.
3. **Webhook receiver:** receives send21 deliveries, verifies `X-Send21-Signature-V2` (`t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<delivery id>.<raw body>">`, refusing deliveries older than 5 minutes), falls back to the v1 `X-Send21-Signature` (HMAC-SHA256 of the raw body) only when no V2 header is present, answers 401 on a bad signature and 200 otherwise, then routes `draft.confirmed` to "Mark order paid" and `draft.amount_mismatch` to "Flag for review".

send21 prepares payment instructions. The payer opens the pay link and signs in their own wallet; send21 never holds keys or funds, never signs and never broadcasts.

## Setup

1. **API key.** At https://send21.io/api-keys create a key with `drafts:write` (for pay links) and `webhooks:manage` (for registering the webhook). You can use two separate keys.
2. **n8n credential.** Create a *Header Auth* credential named `send21 API key` with name `Authorization` and value `Bearer s21_...`. After import, select it on both HTTP Request nodes.
3. **n8n environment.** The signature check runs in a Code node and needs:
   ```sh
   NODE_FUNCTION_ALLOW_BUILTIN=crypto
   SEND21_WEBHOOK_SECRET=<signing secret>   # returned once by POST /webhooks
   ```
   On n8n versions that block `$env` in nodes, also set `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`.
4. **Import.** Workflows > Import from File > `send21-pay-link-workflow.json`.
5. **Register the webhook.** Put your public URL (`https://<your-n8n-host>/webhook/send21`) in the "POST /webhooks" node, activate the workflow, then run "Register webhook (run once)". Copy the signing secret from the response into `SEND21_WEBHOOK_SECRET` and restart n8n. Send a signed `test` delivery with `POST /api/v1/webhooks/{id}/test`.
6. **Create a pay link.** Edit "Pay link settings" (amount, fiat currency, order id, your own receiving addresses) and run "Create pay link (run manually)". The "Pay link" node outputs `payLink`, `paymentRequestId`, `orderId` and `expiresAt`. Send the link to the payer. New send21 accounts only accept receiving addresses the owner approved: approve them in send21 first (passkey or authenticator code), or the request fails with 422 `address_not_approved` and nothing is created.

When the payer signs and the payment reaches its confirmations, send21 posts `draft.confirmed` with your `orderId` and the `txId`. Replace "Mark order paid" with your shop, CRM or spreadsheet update.

## Notes

- Options use the live schema values: currency `Btc`, `Usdc`, `Usdt`, `Eurc`, `Sol` or `Eth`; network `Mainnet` (Bitcoin), `Solana`, `Ethereum`, `Base`, `Arbitrum` or `Polygon`; add `"method": "Lightning"` for BTC to a Lightning address. Use only the [supported combinations](../README.md#supported-currencies-and-networks): USDT only on Solana and Ethereum, no ETH on Polygon, nothing on BNB Chain or Tron.
- An `Idempotency-Key` reused with a different amount, currency or address is refused with 422 and nothing is created, so use a new key for each new payment and reuse a key only to retry the exact same request.
- `reuseOpenForOrder: true` returns the open link for the same `orderId` instead of creating a second one, so re-running the workflow is safe.
- `draft.amount_mismatch` is not a payment: a transfer with a different amount waits until you accept it (`POST /api/v1/drafts/{id}/accept-received`) or decline it (`POST /api/v1/drafts/{id}/reject-received`).
- Deliveries are retried (up to 8 attempts) and can arrive out of order. Skip an `X-Send21-Delivery` id you already handled and key records on `draftId` and `orderId`.
- Account keys use the live networks; the test networks are for the [demo](https://send21.io/demo) only. A pay link moves no money until someone pays it: test with a small one to your own address and cancel it with `POST /api/v1/payment-requests/{id}/cancel`.

Webhook guide: https://send21.io/swagger under Webhooks · Questions: info@send21.io
