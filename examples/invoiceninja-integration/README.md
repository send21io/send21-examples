# Invoice Ninja + send21: crypto pay links on invoices

Connects [Invoice Ninja](https://invoiceninja.com/) v5 to [send21](https://send21.io/). Each new invoice gets a send21 pay link in one of its custom fields. The client opens the link, picks BTC (on-chain or Lightning), USDC, USDT, EURC, SOL or ETH, and signs and sends from their own wallet straight to your receiving address. When the payment confirms, the signed `draft.confirmed` webhook records a **Crypto** payment against the invoice in Invoice Ninja. send21 never holds keys or funds.

### Why an integration and not a payment driver

Invoice Ninja's built-in payment drivers (`app/PaymentDrivers/*PaymentDriver.php`) are part of the core app: each one needs a row in the `gateways` table that ships with a core migration, so a new driver means a pull request to Invoice Ninja itself. This example uses only the documented [REST API](https://api-docs.invoicing.co/) and webhooks, so it works with any Invoice Ninja v5 install (self-hosted or hosted) today, without patching the app. The same rules (signature check, delivery dedupe, exact match) carry over if it becomes a driver later.

## How it works

1. **Invoice created** → Invoice Ninja calls `POST /invoiceninja/webhook` (event `create_invoice`). The request must carry your `X-Webhook-Token` header (set on the Invoice Ninja webhook); otherwise it gets 401.
2. The service reads the invoice, finds its currency (the client's currency via `/api/v1/statics`, or `INVOICENINJA_CURRENCY`), and calls send21 `POST /api/v1/payment-requests` for the **open balance** with `orderId: "invoiceninja-<invoice id>"`, `reuseOpenForOrder: true`, an `Idempotency-Key` of order id plus amount, your receiving options, and an optional `declineNote` (plain text, max 200 characters, shown on the pay page as "If you don't pay:").
3. It writes the link (`https://send21.io` + `payPath`) into the invoice custom field you chose (default `custom_value1`). Label that field "Pay with crypto" in Invoice Ninja and show it on the invoice design or in the email template.
4. **Payment confirmed** → send21 calls `POST /send21/webhook`. The service:
   - checks `X-Send21-Signature-V2` on the raw body (HMAC-SHA256 of `<timestamp>.<X-Send21-Delivery>.<raw body>`, constant time, refused when more than 5 minutes old) and answers 401 otherwise, before reading anything,
   - skips delivery ids it has already handled (retries reuse `X-Send21-Delivery`, and send21 does not dedupe); it records the id only after acting, so a failed attempt is retried,
   - records a payment only for `draft.confirmed` with the same pay link, `orderId`, currency and amount, and only once per invoice link: `POST /api/v1/payments` with `type_id` 31 (Crypto), `transaction_reference` = the transaction id, the invoice and amount, and private notes with the sent amount, network, rate and quote id.
5. Differing amounts (`draft.amount_mismatch`, reminders, unresolved) are left for you: accept or decline them in send21. `payment_request.expired` is noted; the invoice stays open and `npm run create-link <invoice id>` makes a new link.

Refunds are manual. Crypto payments cannot be pulled back and send21 never holds funds: send the refund from your own wallet, then record it in Invoice Ninja.

## Setup

1. `cp .env.example .env` and fill it in:
   - `SEND21_API_KEY`: a send21 key with `drafts:read` and `drafts:write`. It can create pay links; no key can move funds.
   - `SEND21_OPTIONS`: your receiving addresses, saved in send21 as approved addresses ("My own, I receive here").
   - `INVOICENINJA_URL`, `INVOICENINJA_TOKEN` (an API token from Invoice Ninja's settings), `INVOICENINJA_WEBHOOK_TOKEN` (any long random string).
2. Register the send21 webhook (key with `webhooks:manage`) and put the secret it returns once into `SEND21_WEBHOOK_SECRET`:

   ```sh
   curl -X POST https://send21.io/api/v1/webhooks \
     -H "Authorization: Bearer $SEND21_ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"url":"https://pay-bridge.example.com/send21/webhook","events":["draft.confirmed","draft.amount_mismatch","draft.mismatch_reminder","draft.mismatch_unresolved","payment_request.expired"]}'
   ```

3. In Invoice Ninja, add an API webhook in the settings for the **Create invoice** event, POST, target `https://pay-bridge.example.com/invoiceninja/webhook`, with the header `X-Webhook-Token: <your token>`.
4. `npm start` (Node.js 20.12+, no dependencies). It must be reachable over HTTPS on a public address; send21 refuses private and internal webhook URLs.

For an existing invoice: `npm run create-link -- <invoice id>`.

Account keys use the live networks. To try the payer side without an account or money, use the testnet demo at https://send21.io/demo.

## Tests

Offline, with fake HTTP for both APIs:

```sh
cd examples/invoiceninja-integration
npm test
```

Webhook reference: https://send21.io/docs/webhooks · API: https://send21.io/swagger · Fees: https://send21.io/pricing

MIT licensed. Questions: info@send21.io
