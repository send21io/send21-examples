# send21 invoice agent for n8n

An importable n8n workflow, [`send21-invoice-agent.n8n.json`](send21-invoice-agent.n8n.json), that does one real job end to end:

1. **Takes an invoice**: client name, client email, amount and fiat currency, from an n8n form (`/form/send21-invoice`) or as JSON from another system or agent (`POST /webhook/send21-invoice-api`).
2. **Creates a send21 pay link** with `POST /api/v1/payment-requests`, priced in that currency and payable in USDC or USDT on Solana, USDC or EURC on Base, or BTC over Lightning, straight to **your own** addresses. It sends `orderId` = invoice number, `reuseOpenForOrder: true` and an `Idempotency-Key`, so a retry returns the same link instead of billing twice.
3. **Emails the link** to the client and returns it (form page or JSON).
4. **Waits for the signed webhook** and marks the invoice **paid** on `draft.confirmed`, after checking orderId, pay link id, amount and currency. It emails the client a receipt and you a note.

The client picks a currency on the pay page and pays from their own wallet. send21 never holds keys or funds, never signs and never broadcasts.

## Setup (3 steps)

1. **Credentials.** In n8n create a *Bearer Auth* credential named `send21 API key` with your `s21_...` key from https://send21.io/api-keys (scopes `drafts:write`, `drafts:read`, `webhooks:manage`), and an *SMTP* credential. Import the workflow (Workflows > Import from File) and select both credentials where n8n asks.
2. **Settings node.** Fill in at least one of **your own** receiving addresses (`solanaAddress`, `baseAddress`, `lightningAddress`), `ownerEmail` and `senderEmail`. Approve each address yourself in the send21 app first (passkey or authenticator code): an address you did not approve returns `422 address_not_approved` and nothing is created. The client and the workflow input can never change these addresses.
3. **Webhook.** Activate the workflow, put your public URL `https://<your-n8n-host>/webhook/send21-webhook` into **POST /webhooks (send21)** and run **Register webhook (run once)**. Copy the `secret` from its output (shown once) into a *Crypto* credential named `send21 webhook secret` (field *Hmac Secret*) and select it on **HMAC-SHA256 (webhook secret)**. No environment variables or built-in modules are needed, so it also runs on n8n Cloud.

Then open `https://<your-n8n-host>/form/send21-invoice`, or call the API:

```bash
curl -X POST https://<your-n8n-host>/webhook/send21-invoice-api -H "Content-Type: application/json" \
  -d '{"clientName":"Acme Ltd","clientEmail":"ap@acme.example","amount":250,"currency":"EUR","description":"Logo design","invoiceId":"INV-1042"}'
# {"ok":true,"invoiceId":"INV-1042","payLink":"https://send21.io/pay/...","paymentRequestId":"...","expiresAt":"...","emailed":true,...}
```

## How the webhook branch stays safe

- Verifies `X-Send21-Signature-V2` with n8n's Crypto node keyed by the credential (`t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<delivery id>.<raw body>">`) over the raw body, in constant time, and answers **401** to a missing or wrong signature or a delivery **more than 5 minutes old**. It has no fallback to the older body-only signature.
- **Dedupes by `X-Send21-Delivery`.** send21 retries a delivery (up to 8 attempts) with the same id, and deliveries can arrive out of order. Ignoring repeats is the receiver's job, and this workflow does it.
- `draft.amount_mismatch` is **not** a payment. The workflow emails you; you accept or decline the transfer yourself in send21. The workflow never decides.
- `payment_request.expired` marks the invoice expired and tells you whether the client opened the link.

Invoices and handled delivery ids live in the workflow's static data, which n8n saves when a production run ends. That suits a single n8n instance. With queue mode, several workers, or high volume, move both into a database (for example an n8n Data Table or Postgres, with a unique key on the delivery id).

## Test it before a real payment

[`test/send-signed-delivery.mjs`](test/send-signed-delivery.mjs) sends a delivery signed the way send21 signs one, to your webhook URL (Node 18+, no dependencies):

```bash
export SEND21_WEBHOOK_SECRET=...   # the same value as the Crypto credential
node test/send-signed-delivery.mjs https://<your-n8n-host>/webhook/send21-webhook draft.confirmed INV-1042 250 EUR
node test/send-signed-delivery.mjs ... --bad-signature      # expect 401
node test/send-signed-delivery.mjs ... --age 400            # expect 401 (older than 5 minutes)
node test/send-signed-delivery.mjs ... --delivery <same id> # run twice: the second is ignored
```

Or send send21's own signed `test` event: `POST /api/v1/webhooks/{id}/test`.

Tested on n8n 2.44.6 with environment access blocked (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`) and no extra modules: import, publish, form and API paths against the live send21 API (pay link created, email sent through a local SMTP sink, idempotent retry returned the same link), and the webhook branch with signed deliveries (bad signature 401, 5-minute-old delivery 401, amount mismatch flagged, confirmed marked paid with a receipt, repeated delivery ignored, unknown order flagged, `expired` after payment ignored).

Docs: https://send21.io/docs/quickstart, https://send21.io/docs/webhooks. Questions: info@send21.io
