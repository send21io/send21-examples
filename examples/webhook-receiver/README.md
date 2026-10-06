# webhook-receiver

A Node.js server with no dependencies that verifies the send21 webhook signature (`X-Send21-Signature: sha256=<lowercase hex>`, HMAC-SHA256 of the raw body), ignores repeated deliveries by `X-Send21-Delivery`, and handles `draft.confirmed`, `draft.amount_mismatch`, `draft.seen` and `test`. It follows the webhook guide in the Webhooks section at https://send21.io/swagger.

```sh
npm test
SEND21_WEBHOOK_SECRET=<your secret> npm start
npm run send-sample -- draft.confirmed
npm run send-sample -- draft.amount_mismatch
npm run send-sample -- test
```

- `verify.js`: the signature check, copy it into your own app.
- `server.js`: the HTTP receiver, repeated-delivery check and event handler.
- `samples.js`: sample bodies. `draft.amount_mismatch` is the documented example payload.
- `send-sample.js`: posts a locally signed sample event to the running server, with the same headers as a send21 delivery.

See the [main README](../../README.md) for details.
