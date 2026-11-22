# Odoo payment provider for send21

An [Odoo](https://www.odoo.com/) 18 payment provider module, `payment_send21`, for [send21](https://send21.io/). At checkout (eCommerce, customer portal invoices, payment links) the customer is sent to a send21 pay link, picks BTC (on-chain or Lightning), USDC, USDT, EURC, SOL or ETH, and signs and sends from their own wallet straight to your receiving address. The signed `draft.confirmed` webhook sets the Odoo payment transaction to **done**, and Odoo confirms the order or reconciles the invoice as for any provider. send21 never holds keys or funds.

The module follows the structure of Odoo's own redirect providers (for example `payment_mollie` in `odoo/addons` 18.0): `code` added to `payment.provider`, `_get_specific_rendering_values` for the redirect, `_get_tx_from_notification_data` and `_process_notification_data` on `payment.transaction`, a webhook controller, a `redirect_form` template, a provider and a payment method record, and `setup_provider` / `reset_payment_provider` hooks. See Odoo's [payment provider docs](https://www.odoo.com/documentation/18.0/applications/finance/payment_providers.html).

## How it works

1. **Pay link.** When the customer pays, `_get_specific_rendering_values` calls `POST /api/v1/payment-requests` with the transaction amount and currency, `orderId: "odoo-<transaction reference>"`, `reuseOpenForOrder: true`, an `Idempotency-Key` of order id plus amount, your receiving options, an optional `declineNote` (plain text, max 200 characters, shown on the pay page as "If you don't pay:") and `expiryHours` (1 to 720). It stores the send21 payment request id as `provider_reference`, sets the transaction to pending, and redirects to `https://send21.io` + `payPath`.
2. **Signature first.** `/payment/send21/webhook` checks `X-Send21-Signature-V2` on the raw request bytes (HMAC-SHA256 of `<timestamp>.<X-Send21-Delivery>.<raw body>`, constant time, refused when more than 5 minutes old) against the enabled send21 provider's secret, and answers 401 otherwise.
3. **Duplicates.** Retries reuse `X-Send21-Delivery`, and send21 does not dedupe. Handled ids are stored in `payment.send21.delivery` (unique), in the same database transaction as the payment update, so a failed attempt rolls back both and the retry is handled normally.
4. **States.** `draft.confirmed` with the same pay link, order, currency and amount → `_set_done()`. A different confirmed amount, `draft.amount_mismatch`, `draft.mismatch_reminder` or `draft.mismatch_unresolved` → stays pending with a message; accept or decline the transfer in send21. `payment_request.expired` → `_set_canceled()`.
5. **Refunds are manual.** The payment method declares no refund support. Crypto payments cannot be pulled back and send21 never holds funds: send the refund from your own wallet and record it in Odoo.

## Install

1. Copy `payment_send21/` into your addons path and install **Payment Provider: send21** (Apps → Update Apps List).
2. In send21, create an API key with `drafts:read` and `drafts:write`. It can create pay links; no key can move funds. Save your receiving addresses as approved addresses ("My own, I receive here").
3. Register the webhook with a key that has `webhooks:manage`, and keep the signing secret it returns once:

   ```sh
   curl -X POST https://send21.io/api/v1/webhooks \
     -H "Authorization: Bearer $SEND21_ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"url":"https://odoo.example.com/payment/send21/webhook","events":["draft.confirmed","draft.amount_mismatch","draft.mismatch_reminder","draft.mismatch_unresolved","payment_request.expired"]}'
   ```

4. Accounting → Configuration → Payment Providers → **send21**: paste the API key, the signing secret and your receiving options (JSON, for example `[{"currency":"Usdc","network":"Base","address":"0x..."}]`), optionally a decline note, then set the state to **Enabled** and publish it.

Account keys use the live networks. To try the payer side without an account or money, use the testnet demo at https://send21.io/demo.

## Tests

Offline, no Odoo needed (core rules, manifest, XML and Python files):

```sh
cd examples/odoo-payment-provider
python -m unittest discover -s tests -v
```

Inside Odoo 18 (needs PostgreSQL; CI runs this too: 4 tests, including the webhook over HTTP with a bad, an old and a repeated delivery):

```sh
odoo-bin -d test_send21 -i payment_send21 --test-tags /payment_send21 --stop-after-init
```

Webhook reference: https://send21.io/docs/webhooks · API: https://send21.io/swagger · Fees: https://send21.io/pricing

MIT licensed (the manifest says "Other OSI approved licence"). Questions: info@send21.io
