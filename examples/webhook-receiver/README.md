# webhook-receiver

A Node.js server with no dependencies that verifies the send21 webhook signature, ignores repeated deliveries by `X-Send21-Delivery`, and handles `draft.confirmed`, `draft.amount_mismatch`, `draft.mismatch_accepted`, `draft.mismatch_rejected`, `draft.mismatch_reminder`, `draft.mismatch_unresolved`, `draft.seen` and `test`. It verifies `X-Send21-Signature-V2` first (`t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<delivery id>.<raw body>">`) and refuses deliveries older than 5 minutes, so a copied delivery cannot be replayed. The legacy `X-Send21-Signature` (`sha256=<lowercase hex>`, HMAC-SHA256 of the raw body only) is still sent for compatibility and is used only as a fallback when no V2 header is present. It follows the webhook guide in the Webhooks section at https://send21.io/swagger.

```sh
npm test
SEND21_WEBHOOK_SECRET=<your secret> npm start
npm run send-sample -- draft.confirmed
npm run send-sample -- draft.confirmed-accepted
npm run send-sample -- draft.amount_mismatch
npm run send-sample -- test
```

- `verify.js`: the signature check (`verifyDelivery`: V2 first, legacy fallback), copy it into your own app.
- `server.js`: the HTTP receiver, repeated-delivery check and event handler.
- `samples.js`: sample bodies. `draft.amount_mismatch` is the documented example payload. `draft.confirmed-accepted` is a `draft.confirmed` after the owner accepted a different amount, derived from the docs (it is not a documented example payload).
- `send-sample.js`: posts a locally signed sample event to the running server, with the same headers as a send21 delivery (including `X-Send21-Timestamp` and `X-Send21-Signature-V2`).

Mark an order paid on `draft.confirmed` only. When the owner accepts a short or over payment (within 10%), `draft.seen` arrives with `acceptedByOwner: true` and `draft.confirmed` follows with `receivedAmountSats` and `receivedAmount` set, so the receiver logs what arrived.

See the [main README](../../README.md) for details.
