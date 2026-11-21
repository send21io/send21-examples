# Sparrow and hardware-wallet signing

A short guide plus a script: create a Bitcoin draft on [send21](https://send21.io/), fetch `GET /api/v1/drafts/{id}/tx-template`, write the **pay-to-many CSV**, import it in [Sparrow Wallet](https://sparrowwallet.com/), and sign on a hardware wallet such as [Coldcard](https://coldcard.com/).

send21 prepares the outputs. It never holds keys or funds, never signs and never broadcasts. A person signs and sends from their own wallet.

## When this is the right path

Use a **multi-output draft** (`paymentMethod: "MultiOutput"`, `singleOutput: false`) so the send21 fee is a separate output next to the payment, in the same transaction. That is the shape PSBT wallets expect. `singleOutput: true` is the one-QR path, with the fee billed to the account instead.

`GET /drafts/{id}/tx-template` returns:

- `outputs` — each address, amount (sats and BTC) and purpose
- `payToManyCsv` — the CSV Sparrow and Electrum import as pay-to-many
- `walletRpcExample` — a `bitcoin-cli walletcreatefundedpsbt` example
- a `note` when there is something to watch for

Up to 25 drafts can be created in one `POST /drafts/batch`. This guide walks through one draft.

Account API keys use the live Bitcoin network. The test networks are for the [demo](https://send21.io/demo) only. A draft moves no money until you sign it.

## 1. Create the draft

```bash
curl -X POST https://send21.io/api/v1/drafts \
  -H "Authorization: Bearer s21_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: payout-77" \
  -d '{
    "receiverAddress": "bc1qYourReceiverAddress",
    "network": "Mainnet",
    "currency": "Btc",
    "paymentMethod": "MultiOutput",
    "singleOutput": false,
    "fiatCurrency": "EUR",
    "fiatAmount": 25
  }'
```

The key needs `drafts:write` to create and `drafts:read` to fetch the template. It cannot move funds. On default ApprovedOnly accounts, the receiver address must already be approved in send21 (passkey or authenticator code). `expiryHours` is 1 to 720 (default 24) and never moves once the draft is created.

## 2. Fetch the template and write the CSV

```sh
cd examples/sparrow-hardware-wallet
export SEND21_API_KEY=s21_...
node fetch-tx-template.js --draft <draft-id> --out pay-to-many.csv
```

The script prints each output (so you can check the receiver and the fee address), writes `pay-to-many.csv`, and prints the `walletRpcExample` when the API includes one.

```sh
npm test
```

## 3. Import in Sparrow and sign on a hardware wallet

1. Open Sparrow with the wallet that will pay (or a watch-only wallet bound to your hardware signer).
2. Start a new transaction. Use Sparrow's pay-to-many / CSV import (File or the send screen, depending on your Sparrow version) and choose the CSV this script wrote.
3. Check **every** address and amount against the script output. Address poisoning relies on people skimming the first and last characters; compare the full strings, including the fee output.
4. Send the transaction to your hardware wallet (Coldcard via USB, QR or microSD; other PSBT signers work the same way through Sparrow).
5. Verify the same addresses and amounts on the hardware wallet's screen, sign, bring the signed PSBT back to Sparrow, and broadcast.

Electrum has a similar pay-to-many CSV import if you prefer it. Bitcoin Core users can paste `walletRpcExample` into `bitcoin-cli` instead of using the CSV.

## 4. Confirmation

When the payment reaches its required confirmations, the draft status becomes `Confirmed` and `confirmedAt` is set once. Prefer a verified `draft.confirmed` webhook over polling; see [webhook-receiver](../webhook-receiver). Status values are `AwaitingPayment`, `Seen`, `Confirmed`, `Expired` and `Cancelled`.

If a transfer arrives within 10% of the billed amount, it is not confirmed on its own: `amountMismatch.reviewState` is `pending` until you accept or decline it. The money is already in the receiving wallet.

Docs: https://send21.io/docs/quickstart · Questions: info@send21.io
