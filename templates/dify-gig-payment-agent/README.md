# send21 gig payment agent for Dify

An importable Dify workflow app, [`send21-gig-payment-agent.dify.yml`](send21-gig-payment-agent.dify.yml), that turns a finished job into a quote and a send21 crypto pay link, plus a message for the client.

**Inputs:** client name, what was done, hours, hourly rate, extra costs (or a fixed price), currency and an optional job id.
**Outputs:** `pay_link`, `payment_request_id`, `expires_at`, `total`, `job_id`, `quote` (the line items) and `client_message`.

Steps: **Quote** (a Code node computes the total, so the model never does the maths) → **Create send21 pay link** (HTTP Request, `POST /api/v1/payment-requests` with `Idempotency-Key`, `orderId` = job id and `reuseOpenForOrder: true`) → **Read answer** (builds `https://send21.io` + `payPath`, or stops with a clear reason such as `address_not_approved`) → **Write client message** (LLM, only words the message; amount and link come from the steps before) → End.

Run it from the Dify UI, or call it as an API from another agent (`POST /v1/workflows/run` with the app's API key).

The receiving addresses are environment variables only the app owner sets. A run's inputs cannot change where the money goes. The client pays from their own wallet; send21 never holds keys or funds.

## Setup (3 steps)

1. **Import.** In Dify: Studio > Import DSL file > `send21-gig-payment-agent.dify.yml`.
2. **Environment variables** (workflow > Env): `SEND21_API_KEY` (secret, an `s21_...` key with `drafts:write`, created at https://send21.io/api-keys in your account) and at least one of your own addresses: `SEND21_SOLANA_ADDRESS` (USDC and USDT on Solana), `SEND21_BASE_ADDRESS` (USDC and EURC on Base), `SEND21_LIGHTNING_ADDRESS` (BTC over Lightning, name@wallet.com). Approve each address yourself in the send21 app first (passkey or authenticator code). An unapproved address returns `422 address_not_approved` and nothing is created. No API key can approve an address.
3. **Model.** Pick any chat model in **Write client message** (the template names OpenAI `gpt-4o-mini`; install the provider plugin or switch it), then Run.

Re-running with the same job id returns the same open link. A changed amount needs a new job id.

## Paid status

Dify answers when the pay link is created. To mark the job paid when it confirms, register a send21 webhook (`POST /api/v1/webhooks`, events `draft.confirmed` and `draft.amount_mismatch`) on a receiver that verifies `X-Send21-Signature-V2` over the raw body, refuses deliveries more than 5 minutes old, and ignores delivery ids it already handled (`X-Send21-Delivery`; send21 retries with the same id). Ready-made receivers: [examples/webhook-receiver](../../examples/webhook-receiver), the [n8n invoice agent](../n8n-invoice-agent) and the [LangGraph invoice agent](../langgraph-invoice-agent). A payment with a different amount is never confirmed on its own: you accept or decline it in send21.

## What was tested

The DSL (version 0.3.1, imports on current Dify with a minor-version note) validates node by node against the data models of `graphon`, Dify's workflow engine, and every `{{#node.var#}}` reference points to a real node or environment variable. Both Code nodes ran exactly as written in the DSL. The HTTP Request node's headers, bearer auth and JSON body were built by graphon's own HTTP executor and sent to the live send21 API, which returned the pay link. An invalid address came back as a clear stop, and an empty total was refused before any call. The template was not imported into a running Dify instance.

Docs: https://send21.io/docs/quickstart · Questions: info@send21.io
