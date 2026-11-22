# FOSSBilling payment adapter for send21

A [FOSSBilling](https://fossbilling.org/) payment adapter for [send21](https://send21.io/). The client opens an invoice, presses **Pay with crypto**, picks BTC (on-chain or Lightning), USDC, USDT, EURC, SOL or ETH on the send21 pay page, and signs and sends from their own wallet straight to your receiving address. When send21 sends the signed `draft.confirmed` webhook, the adapter adds the amount to the client's balance and pays the invoice with it, the same way FOSSBilling's built-in adapters do. send21 never holds keys or funds.

It follows FOSSBilling's adapter convention: one class `Payment_Adapter_Send21` in `src/library/Payment/Adapter/Send21.php` with `getConfig()` (the admin form), `getHtml()` (what the client sees on the invoice) and `processTransaction()` (called by `ipn.php` for each callback), plus a logo in `src/public/gateways/`. Written against FOSSBilling 0.8.x (tested shapes from 0.8.9). See the [FOSSBilling docs](https://fossbilling.org/docs) and the built-in adapters (`Custom.php`, `PayPalEmail.php`) for reference.

## Install

1. Copy `src/library/Payment/Adapter/Send21.php` to the same path in your FOSSBilling install, and `src/public/gateways/send21.png` to `src/public/gateways/`.
2. In send21, create an API key with `drafts:read` and `drafts:write`. It can create pay links; no key can move funds. Save your receiving addresses as approved addresses ("My own, I receive here").
3. In FOSSBilling: **Settings → Payment gateways → New payment gateway → send21**. Fill in:
   - **API key** (`s21_...`),
   - **Receiving options** as JSON, for example `[{"currency":"Usdc","network":"Base","address":"0x..."},{"currency":"Btc","network":"Mainnet","address":"you@wallet.com","method":"Lightning"}]`,
   - optional **decline note** (plain text, max 200 characters, shown on the pay page as "If you don't pay:"),
   - optional **expiry hours** (1 to 720, default 24; never moves once the link exists).
   Note the gateway's id.
4. Register the webhook with a key that has `webhooks:manage`, and paste the signing secret it returns (once) into the gateway's **Webhook signing secret** field:

   ```sh
   curl -X POST https://send21.io/api/v1/webhooks \
     -H "Authorization: Bearer $SEND21_ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"url":"https://billing.example.com/ipn.php?gateway_id=7","events":["draft.confirmed","draft.amount_mismatch","draft.mismatch_reminder","draft.mismatch_unresolved","payment_request.expired"]}'
   ```

## What it does

- **Pay link per invoice.** `getHtml()` calls `POST /api/v1/payment-requests` with the invoice total and currency, `orderId: "fossbilling-invoice-<id>"`, `reuseOpenForOrder: true` and an `Idempotency-Key` of the order id plus the total, so reloading the invoice returns the same open link. The link is `https://send21.io` + `payPath`. The card is light (white, grey text, one orange button).
- **Signature first.** `processTransaction()` checks `X-Send21-Signature-V2` on the raw body (HMAC-SHA256 of `<timestamp>.<X-Send21-Delivery>.<raw body>`, constant time, refused when more than 5 minutes old). A bad signature throws before anything is read or changed.
- **No double payments.** Retries reuse `X-Send21-Delivery`, and send21 does not dedupe. The adapter stores `send21-delivery:<id>` in the transaction's `note` and skips any delivery id it has already handled. It also skips invoices that are already paid.
- **Exact match.** It pays the invoice only when `orderId`, `fiatCurrency` and `fiatAmount` match the invoice. The send21 transaction id (`txId`) is stored as the FOSSBilling transaction id.
- **Differing amounts** (`draft.amount_mismatch`, reminders, unresolved) and a different confirmed price are marked "needs your decision" on the transaction. Accept or decline the transfer in send21.
- **Expired links** (`payment_request.expired`) are logged; the invoice stays unpaid and the client can open it again for a new link.
- **Refunds are manual.** Crypto payments cannot be pulled back and send21 never holds funds. Send the refund from your own wallet, then record it in FOSSBilling.
- Subscriptions are not supported by this adapter (each invoice is a one-time payment).

Account keys use the live networks. To try the payer side without an account or money, use the testnet demo at https://send21.io/demo.

## Tests

Offline, with plain PHP 8.1+ and no FOSSBilling checkout (`tests/bootstrap.php` provides small stand-ins for the FOSSBilling classes):

```sh
cd examples/fossbilling-adapter
php tests/run.php
```

The tests cover the request body, `declineNote`, option checks, the HTML card, the V2 signature window, paying once, ignoring a repeated delivery id, refusing bad signatures, and leaving differing amounts and expiries unpaid.

Webhook reference: https://send21.io/docs/webhooks · API: https://send21.io/swagger · Fees: https://send21.io/pricing

MIT licensed. Questions: info@send21.io
