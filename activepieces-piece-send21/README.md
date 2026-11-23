# Activepieces piece: send21

An [Activepieces](https://www.activepieces.com/) community piece for [send21](https://send21.io): crypto pay links and API for people and AI agents.

send21 is non-custodial software that prepares payment instructions, payment drafts and pay links. A flow creates them through the REST API; a person signs and sends the payment from their own wallet. send21 never holds keys or funds, never signs and never broadcasts. No API key can move funds.

## Install in Activepieces

The piece is published on npm as [`activepieces-piece-send21`](https://www.npmjs.com/package/activepieces-piece-send21). A platform admin can install it from npm on a self-hosted instance (and on Activepieces Cloud, where installing a piece from npm is a platform feature):

1. Open **Settings → My Pieces** (also called **Pieces**).
2. Click **Install Piece**.
3. Keep the package type on the npm registry, enter `activepieces-piece-send21`, and install.

The piece then appears in the step picker as **send21**. Create a connection with a scoped API key from [send21.io/api-keys](https://send21.io/api-keys). Paste the key only (`s21_...`), without the word Bearer. Use `drafts:write` to create pay links and drafts, `drafts:read` to read them, and `webhooks:manage` so the trigger can register its endpoint.

Account API keys use the live networks. The test networks are for the [demo](https://send21.io/demo) only. A draft or pay link moves no money until a person pays it.

Activepieces docs: [Community (Public NPM)](https://www.activepieces.com/docs/build-pieces/sharing-pieces/community).

## Actions

| Action | API |
| --- | --- |
| Create Payment Request | `POST /api/v1/payment-requests` |
| Create Draft | `POST /api/v1/drafts` |
| Get Draft | `GET /api/v1/drafts/{id}` |
| Get Draft Status | `GET /api/v1/drafts/{id}/status` |

Create calls send an `Idempotency-Key` header. A payment request output includes `payLink` (`https://send21.io` plus `payPath`). `expiryHours` is 1 to 720 (default 24) and never moves after create.

## Trigger

**Payment Event (Webhook)** registers a public HTTPS URL with `POST /api/v1/webhooks` when you publish the flow, and deletes it when you turn the flow off. It verifies **`X-Send21-Signature-V2`** (`t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<delivery id>.<raw body>">`) and refuses deliveries older than 5 minutes. A missing or wrong signature is rejected, so send21 does not treat it as delivered.

send21 retries a delivery that does not get a 2xx, or that gets no answer within 15 seconds, and reuses the same `X-Send21-Delivery` id on those retries (up to 8 attempts). The trigger remembers the last 200 delivery ids and runs once per id.

`draft.amount_mismatch` is not a payment: a transfer within 10% of the billed amount waits until you accept or decline it. The money is already in the receiving wallet. With a shortfall policy, small shortfalls can be accepted automatically; overpayments always wait for a person.

## Local build

```sh
cd activepieces-piece-send21
npm install
npm run build
npm test
```

`npm run build` typechecks the TypeScript and writes a self-contained CommonJS bundle to `dist/`, which is what gets published to npm. The Activepieces framework is inlined in that bundle.

This package lives in [send21-examples](https://github.com/send21io/send21-examples/tree/main/activepieces-piece-send21). It is a community piece on npm, not an official Activepieces catalog piece.

Docs: https://send21.io/docs/quickstart · Webhooks: https://send21.io/docs/webhooks · Questions: info@send21.io
