# webhook-receiver

A Node.js server with no dependencies that verifies the send21 webhook signature (`X-Send21-Signature: sha256=<hex>`, HMAC-SHA256 of the raw body) and handles `draft.confirmed` and `draft.amount_mismatch`.

```sh
npm test
SEND21_WEBHOOK_SECRET=<your secret> npm start
npm run send-sample -- draft.confirmed
```

- `verify.js`: the signature check, copy it into your own app.
- `server.js`: the HTTP receiver and event handler.
- `send-sample.js`: posts a locally signed sample event to the running server.

See the [main README](../../README.md) for details.
