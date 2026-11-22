# send21 for Frappe / ERPNext

A [Frappe](https://frappe.io/framework) app that adds [send21](https://send21.io/) crypto pay links to ERPNext Sales Invoices. The customer opens the link, picks BTC (on-chain or Lightning), USDC, USDT, EURC, SOL or ETH, and signs and sends from their own wallet straight to your receiving address. When send21 sends the signed `draft.confirmed` webhook, the app submits a Payment Entry against the invoice. send21 never holds keys or funds.

It is a standard Frappe app, laid out as `bench new-app` creates it (`pyproject.toml`, `hooks.py`, `modules.txt`, `patches.txt`, a module folder with DocTypes, fixtures and `public/js`). See the [Frappe docs on apps](https://docs.frappe.io/framework/user/en/basics/apps).

## What is in it

| Part | What it does |
| --- | --- |
| **Send21 Settings** (single DocType) | API key and webhook signing secret (Password fields), receiving options (JSON), decline note, pay link lifetime, Mode of Payment and the account that tracks your own wallet. |
| **Send21 Pay Link** | One row per invoice order: pay link, send21 payment request id, amount, currency, status (Open, Paid, Expired, Needs review), transaction id and Payment Entry. |
| **Send21 Webhook Delivery** | Handled `X-Send21-Delivery` ids (the DocType name is the delivery id, so it is unique). |
| Sales Invoice field and button | A read-only **send21 Pay Link** field (fixture) and **Create → send21 pay link** on submitted, unpaid invoices. Optional: create it automatically on submit. |
| `api.webhook` | `https://<site>/api/method/send21_payments.api.webhook`, the endpoint you register in send21. |
| `send21_core.py` | The rules, with no Frappe import: request body, `declineNote`, signature check, decisions. Unit-tested on its own. |

## How it works

1. **Pay link.** `create_pay_link` calls `POST /api/v1/payment-requests` for the invoice's **outstanding amount** in the invoice currency, with `orderId: "erpnext-sinv-<invoice name>"`, `reuseOpenForOrder: true`, an `Idempotency-Key` of the order id plus amount, your receiving options and an optional `declineNote` (plain text, max 200 characters, shown on the pay page as "If you don't pay:"). The link is `https://send21.io` + `payPath`; put the **send21 Pay Link** field on your print format or email template.
2. **Signature first.** The webhook checks `X-Send21-Signature-V2` on the raw request bytes (HMAC-SHA256 of `<timestamp>.<X-Send21-Delivery>.<raw body>`, constant time, refused when more than 5 minutes old) and answers 401 otherwise.
3. **Duplicates.** Retries reuse `X-Send21-Delivery`, and send21 does not dedupe. A delivery id already in **Send21 Webhook Delivery** is answered 200 without acting. The delivery row and the Payment Entry are written in the same database transaction, so a failure rolls back both and the retry is handled normally.
4. **Payment Entry.** Only for `draft.confirmed` with the same pay link, `orderId`, currency and amount, and only once per pay link: `get_payment_entry("Sales Invoice", …)` with your Mode of Payment and account, `reference_no` = transaction id, `reference_date` = confirmation date, and remarks with the sent amount, network, rate, quote id and draft id.
5. **Differing amounts** (`draft.amount_mismatch`, reminders, unresolved) and a different confirmed price set the pay link to **Needs review**. Accept or decline the transfer in send21. `payment_request.expired` sets it to **Expired**; create a new link from the invoice.
6. **Refunds are manual.** Crypto payments cannot be pulled back and send21 never holds funds. Send the refund from your own wallet and book it in ERPNext as usual.

## Install

`bench get-app` expects an app at the root of a git repository. Copy this folder into its own repository (or a local git folder), then:

```sh
bench get-app <that repository URL or local path>
bench --site your.site install-app send21_payments
bench build --app send21_payments
```

Then:

1. In send21, create an API key with `drafts:read` and `drafts:write`. It can create pay links; no key can move funds. Save your receiving addresses as approved addresses ("My own, I receive here").
2. Register the webhook with a key that has `webhooks:manage` and keep the signing secret it returns once:

   ```sh
   curl -X POST https://send21.io/api/v1/webhooks \
     -H "Authorization: Bearer $SEND21_ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"url":"https://erp.example.com/api/method/send21_payments.api.webhook","events":["draft.confirmed","draft.amount_mismatch","draft.mismatch_reminder","draft.mismatch_unresolved","payment_request.expired"]}'
   ```

3. Open **Send21 Settings**, tick **Enabled**, and fill in the key, the secret, your receiving options, a Mode of Payment (for example "Crypto") and the account that tracks your wallet.

Account keys use the live networks. To try the payer side without an account or money, use the testnet demo at https://send21.io/demo.

## Tests

The rules run offline with plain Python 3.10+, no Frappe or ERPNext needed:

```sh
cd examples/frappe-erpnext-app
python -m unittest discover -s send21_payments/tests -t . -v
```

`api.py` and the DocType controllers import `frappe` and `erpnext` and run inside a bench.

Webhook reference: https://send21.io/docs/webhooks · API: https://send21.io/swagger · Fees: https://send21.io/pricing

MIT licensed. Questions: info@send21.io
