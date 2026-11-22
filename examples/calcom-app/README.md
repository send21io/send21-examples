# Cal.com app: take crypto payments for bookings with send21

A [Cal.com](https://cal.com/) payment app for [send21](https://send21.io/). When someone books a paid event, the app creates a send21 pay link for the booking. The booker picks BTC (on-chain or Lightning), USDC, USDT, EURC, SOL or ETH on the send21 pay page, and signs and sends from their own wallet, straight to your receiving address. send21 never holds keys or funds, never signs and never broadcasts.

- **Confirmed** when the signed `draft.confirmed` webhook arrives with the booking's `orderId` and the booked price.
- **Released** when the pay link expires unpaid (`payment_request.expired`): the booking is cancelled and the slot opens again.
- **Held for you** when a different amount arrives (`draft.amount_mismatch`): you accept or decline it in send21. Refunds are manual, from your own wallet.

The folder `send21/` follows the layout of Cal.com's app store (`packages/app-store/<slug>/`, as created by `yarn create-app` and used by the existing payment apps such as BTCPay Server and Alby): `config.json`, `api/add.ts`, `api/webhook.ts`, `lib/PaymentService.ts` implementing `IAbstractPaymentService`, `zod.ts`, the event-type app card and a setup page. See Cal.com's [app store guide](https://cal.com/docs/developing/guides/appstore-and-integration/build-an-app) and `packages/app-store/CONTRIBUTING.md`.

## How it works

1. **Pay link per booking.** `PaymentService.create` calls `POST /api/v1/payment-requests` with:
   - `fiatAmount` and `fiatCurrency` from the event price (Cal.com stores cents; zero-decimal currencies such as JPY are passed as is),
   - `orderId: "cal-booking-<bookingId>"`, `reuseOpenForOrder: true` and the same value as `Idempotency-Key`, so a retry or a reload returns the same open link instead of a second one,
   - `declineNote` (plain text, max 200 characters), shown on the pay page as "If you don't pay:". Default: "The booking is released and the time slot opens for someone else.",
   - `expiryHours` (1 to 720, default 24; it never moves once the link exists). For bookings a short window, such as 2 hours, keeps slots from being held for long,
   - your receiving `options` (currency, network, address, optional `method: "Lightning"`).

   The payment record stores the send21 payment request id as `externalId` and the link (`https://send21.io` + `payPath`) in `data.payLink`.
2. **Webhook.** `api/webhook.ts` answers at `/api/integrations/send21/webhook`. It reads the raw body, finds the payment by `paymentRequestId`, and checks `X-Send21-Signature-V2` with that owner's signing secret: HMAC-SHA256 of `<timestamp>.<X-Send21-Delivery>.<raw body>`, constant-time, refusing deliveries more than 5 minutes old (401). Nothing changes before that check.
3. **Duplicates.** Retries reuse `X-Send21-Delivery`, and send21 does not dedupe for you. The app keeps the last 50 handled delivery ids on the payment record and answers 200 to a repeat without acting again. It records the id only after acting, so a failed attempt is retried, not skipped.
4. **Decision** (`lib/send21.ts`, tested on its own):
   - `draft.confirmed` with the same `paymentRequestId`, `orderId`, `fiatCurrency` and `fiatAmount` → `handlePaymentSuccess` confirms the booking,
   - same event with another price → kept pending for you to check,
   - `payment_request.expired` while unpaid → booking cancelled with reason "Payment link expired unpaid" (unless a differing transfer is waiting for your decision),
   - `draft.amount_mismatch`, `draft.mismatch_reminder`, `draft.mismatch_unresolved` → kept pending; decide in send21 with accept-received or reject-received.

## Install into a Cal.com checkout

1. Copy `send21/` to `packages/app-store/send21/` in your Cal.com fork and run `yarn app-store:build`, which regenerates the app store registry files (`yarn app-store:watch` while developing).
2. In send21, create an API key with `drafts:read` and `drafts:write`. The key can prepare pay links; no key can move funds. Save your receiving addresses as approved addresses ("My own, I receive here"). New accounts only accept approved receiving addresses.
3. Register the webhook with a key that has `webhooks:manage`, and keep the signing secret it returns once:

   ```sh
   curl -X POST https://send21.io/api/v1/webhooks \
     -H "Authorization: Bearer $SEND21_ADMIN_KEY" -H "Content-Type: application/json" \
     -d '{"url":"https://cal.example.com/api/integrations/send21/webhook","events":["draft.confirmed","draft.amount_mismatch","draft.mismatch_reminder","draft.mismatch_unresolved","payment_request.expired"]}'
   ```

4. Install the app in Cal.com, open its setup page and paste the API key, the signing secret, your receiving options and (optionally) your decline note. The secrets stay on the Cal.com credential and are never sent back to the browser.
5. Turn on **send21** for an event type and set its price.

Cal.com shows payment-app UI on its `/payment/[uid]` page. How a payment app's component is wired there differs between Cal.com versions; follow how BTCPay Server or Alby do it in your version and render `components/Send21PayLink.tsx` with `payment.data.payLink` (a light card with one orange button).

Account keys use the live networks. To try the payer side without an account or money, use the testnet demo at https://send21.io/demo.

## Tests

The rules (request body, `declineNote`, signature check, decisions, dedupe) live in `send21/lib/send21.ts` with no Cal.com imports, so they run offline:

```sh
cd examples/calcom-app
npm test   # Node.js 22.18 or newer (runs the TypeScript tests directly)
```

The Cal.com wiring (`api/`, `components/`, `pages/`, `lib/PaymentService.ts`) imports `@calcom/*` packages and compiles inside a Cal.com checkout.

## Notes

- send21 never holds funds, so there are no holds, escrow or automatic refunds. To refund, send the money from your own wallet, then mark the payment refunded in Cal.com.
- Fees: https://send21.io/pricing. Webhook reference: https://send21.io/docs/webhooks. API: https://send21.io/swagger.

MIT licensed. Questions: info@send21.io
