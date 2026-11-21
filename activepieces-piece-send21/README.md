# Activepieces piece: send21

An [Activepieces](https://www.activepieces.com/) community piece for [send21](https://send21.io/): crypto pay links and API for people and AI agents.

send21 is non-custodial software that prepares payment instructions, payment drafts and pay links. A flow creates them through the REST API; a person signs and sends the payment from their own wallet. send21 never holds keys or funds, never signs and never broadcasts. No API key can move funds.

This folder is ready to copy into the Activepieces monorepo as `packages/pieces/community/send21`. An upstream pull request is not opened from here; that outreach is a follow-up.

## Actions

| Action | API |
| --- | --- |
| Create Payment Request | `POST /api/v1/payment-requests` |
| Create Draft | `POST /api/v1/drafts` |
| Get Draft | `GET /api/v1/drafts/{id}` |
| Get Draft Status | `GET /api/v1/drafts/{id}/status` |

Create calls send an `Idempotency-Key` header. A payment request output includes `payLink` (`https://send21.io` plus `payPath`). `expiryHours` is 1 to 720 (default 24) and never moves after create.

## Trigger

**Payment Event (Webhook)** registers a public HTTPS URL with `POST /api/v1/webhooks` when you publish the flow, and deletes it when you turn the flow off. It verifies **`X-Send21-Signature-V2`** (`t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<delivery id>.<raw body>">`) and refuses deliveries older than 5 minutes.

`draft.amount_mismatch` is not a payment: a transfer within 10% of the billed amount waits until you accept or decline it. The money is already in the receiving wallet. With a shortfall policy, small shortfalls can be accepted automatically; overpayments always wait for a person.

## Local build

This copy uses published npm packages so it can be built outside the Activepieces monorepo:

```sh
cd activepieces-piece-send21
npm install
npm run build
npm test
```

Account API keys use the live networks. The test networks are for the [demo](https://send21.io/demo) only. A draft or pay link moves no money until a person pays it.

## Opening an upstream PR (follow-up)

1. Copy this folder to `packages/pieces/community/send21` in [activepieces/activepieces](https://github.com/activepieces/activepieces).
2. Switch `@activepieces/pieces-common` and `@activepieces/pieces-framework` to `workspace:*`, point `tsconfig.json` at the monorepo base config (see neighbouring pieces such as `cal-com`), and add `categories: [PieceCategory.COMMERCE]` (import `PieceCategory` from `@activepieces/pieces-framework`).
3. Register the piece in the monorepo's piece index if that step is still required.
4. Open the pull request against `activepieces/activepieces`.

Docs: https://send21.io/docs/quickstart · Webhooks: https://send21.io/docs/webhooks · Questions: info@send21.io
