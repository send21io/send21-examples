# Nostr pay-link bot for send21

Take crypto payments on Nostr with [send21](https://send21.io/). Two parts, both small:

- **Pay button note.** `create-button.js` creates a send21 pay button, a reusable link `https://send21.io/b/<token>` with the amount, coins and receiving addresses you locked. `post-note.js` publishes it as a kind-1 note. Nothing in the link is secret.
- **DM bot.** People send your bot a private message (NIP-17), for example `pay coffee`. The bot answers with a fresh send21 pay link for that item from a fixed menu. When a payment confirms, the bot sends the payer a private thank-you message.

The payer signs and sends from their own wallet, straight to your addresses. send21 never holds funds or keys, and the send21 API key cannot move funds: it only creates pay links.

## How the DM bot works

1. The bot listens on your relays for gift wraps (kind 1059) tagged with its pubkey and unwraps them with nostr-tools' `nip17`.
2. `pay <item>` makes `POST /api/v1/payment-requests` with the menu's amount and currency, `orderId` = `nostr-<rumor id>` (also sent as the `Idempotency-Key`), `reuseOpenForOrder: true`, `expiryHours` and a `declineNote`. Payers can only pick menu items. They cannot set an amount or an address.
3. The reply is a NIP-17 DM with `https://send21.io` + `payPath`. `menu` or `help` lists the items.
4. At most 3 new links per sender per hour. A DM the bot already answered (relays resend old gift wraps after a restart) is skipped.
5. `POST /send21/webhook` verifies `X-Send21-Signature-V2` (HMAC-SHA256 over `<t>.<delivery id>.<raw body>`, 5-minute window, constant-time compare) and ignores `X-Send21-Delivery` ids it has already handled, because send21 does not dedupe deliveries.
6. On `draft.confirmed` the bot checks `orderId`, `paymentRequestId`, `fiatCurrency` and `fiatAmount` against the link it made. It DMs "Payment confirmed" only on an exact match. A different amount gets a neutral "I will check it" message, and so does `draft.amount_mismatch`. `payment_request.expired` tells the payer the link expired.

Links and handled delivery ids are kept in a small JSON file (`STORE_PATH`), so they survive a restart. Refunds stay manual: send them from your own wallet.

## Set up

```bash
npm ci
cp .env.example .env
node keygen.js >> .env      # creates the bot key; prints the npub to share
```

Then fill in `.env`:

- `SEND21_API_KEY`: a key from the send21 app with `drafts:read` and `drafts:write`.
- `SEND21_OPTIONS`: your receiving options. Currencies are `Btc`, `Usdc`, `Usdt`, `Eurc`, `Sol` and `Eth`. Networks are `Mainnet`, `Solana`, `Ethereum`, `Base`, `Arbitrum` and `Polygon`. `method` is `Lightning` or `MultiOutput`.
- `BOT_MENU`: what payers can ask for.
- `SEND21_WEBHOOK_SECRET`: register `https://your-host/send21/webhook` with `POST /api/v1/webhooks` (`webhooks:manage`) for `draft.confirmed`, `draft.amount_mismatch` and `payment_request.expired`. The secret is shown once.

```bash
npm start
```

Post a pay button note:

```bash
node --env-file=.env create-button.js "Buy me a coffee" 5 EUR   # prints https://send21.io/b/<token>
node --env-file=.env post-note.js https://send21.io/b/<token> "Tips welcome"
```

You can also make the button in the send21 app under **Buttons**. Payments that start from a button show up under **Requests** with the reference `button:<id>`. The DM bot ignores their webhooks because it did not create them.

Try the payer flow on testnet first: https://send21.io/demo

## Keys

No keys are committed. `.env` is git-ignored, and the tests generate throwaway keys on every run. Keep the bot's `nsec` like a password: it signs the bot's messages. It is not a wallet key and holds no funds.

## Tests

```bash
npm test
```

The tests run offline. They make no relay or network calls: send21 is a stub, and the NIP-17 DMs are wrapped and unwrapped in memory. They cover the commands, the menu and the request body, private replies, ignoring wraps meant for someone else, the rate limit, the V2 signature (valid, tampered, stale, wrong delivery id), delivery dedupe, the exact-match check and the note signature.

## Files

- `src/send21.js`: request and button bodies, the API call, V2 signature verification.
- `src/bot.js`: commands, menu, NIP-17 handling, webhook to DM, note building.
- `main.js`: relays (nostr-tools `SimplePool`) and the webhook server.
- `create-button.js`, `post-note.js`, `keygen.js`: one-off scripts.

## License and contact

MIT. Questions: info@send21.io
