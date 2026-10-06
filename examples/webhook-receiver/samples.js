// Sample webhook bodies for send-sample.js and the tests.
//
// draft.amount_mismatch is the example payload from the Webhooks section of
// https://send21.io/swagger, byte for byte. draft.confirmed uses the same field
// list (the docs say draft.seen and draft.confirmed carry the same fields, and
// receivedAmountSats and receivedAmount are set only when the amount differs),
// with the exact billed amount received.
//
// draft.confirmed after an accepted different amount is DERIVED FROM THE DOCS,
// not a documented example payload. The Webhooks section says receivedAmountSats
// and receivedAmount are set "including on the draft.confirmed of an accepted
// short or over payment", so this sample is the documented mismatch example with
// a confirmed status and both received amounts kept. The test event has the documented
// data fields, message and occurredAt (the message text here is a placeholder).
//
// Amounts ending in Sats are base units of the sent asset: 8 decimals for BTC,
// 6 for USDC, USDT and EURC, 9 for SOL and ETH (ETH amounts are in gwei).

export const amountMismatchBody = `{
  "event": "draft.amount_mismatch",
  "data": {
    "draftId": "3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c",
    "status": "AwaitingPayment",
    "txId": "5KqZ9bQ...",
    "confirmations": 1,
    "receivedAmountSats": 49250000,
    "receivedAmount": "49.250000",
    "sentCurrency": "USDC",
    "network": "Solana",
    "amountSats": 50000000,
    "sentAmount": "50.000000",
    "fiatCurrency": "EUR",
    "fiatAmount": 46.00,
    "conversionRate": 0.92,
    "rateSource": "coinbase",
    "platformFee": {
      "accrued": true, "waived": false, "percent": 0.39, "feeUsd": 0.20,
      "feeBaseUnits": 195000, "feeAmount": "0.195000", "currency": "USDC"
    },
    "paymentRequestId": "8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b",
    "orderId": "ORDER-1042",
    "occurredAt": "2026-10-06T08:22:22Z"
  }
}`;

export const confirmedBody = JSON.stringify({
  event: "draft.confirmed",
  data: {
    draftId: "3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c",
    status: "Confirmed",
    txId: "5KqZ9bQ...",
    confirmations: 1,
    sentCurrency: "USDC",
    network: "Solana",
    amountSats: 50000000,
    sentAmount: "50.000000",
    fiatCurrency: "EUR",
    fiatAmount: 46.0,
    conversionRate: 0.92,
    rateSource: "coinbase",
    platformFee: {
      accrued: true,
      waived: false,
      percent: 0.39,
      feeUsd: 0.2,
      feeBaseUnits: 195000,
      feeAmount: "0.195000",
      currency: "USDC",
    },
    paymentRequestId: "8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b",
    orderId: "ORDER-1042",
    occurredAt: "2026-10-06T08:25:10Z",
  },
});

// Derived from the docs, see the note at the top of this file.
export const confirmedAcceptedBody = JSON.stringify({
  event: "draft.confirmed",
  data: {
    ...JSON.parse(confirmedBody).data,
    receivedAmountSats: 49250000,
    receivedAmount: "49.250000",
    occurredAt: "2026-10-06T08:40:00Z",
  },
});

export const testBody = JSON.stringify({
  event: "test",
  data: { message: "Test event", occurredAt: "2026-10-06T08:30:00Z" },
});

/** Raw bodies by event type. */
export const samples = {
  "draft.confirmed": confirmedBody,
  "draft.confirmed-accepted": confirmedAcceptedBody,
  "draft.amount_mismatch": amountMismatchBody,
  test: testBody,
};
