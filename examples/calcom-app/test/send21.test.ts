import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  alreadyHandled,
  buildPaymentRequest,
  cleanDeclineNote,
  decide,
  parseReceiveOptions,
  payLinkFromPath,
  rememberDelivery,
  signV2,
  toMajorUnits,
  verifySignatureV2,
} from "../send21/lib/send21.ts";

const options = parseReceiveOptions([
  { currency: "Usdc", network: "Base", address: "0xReceiver" },
  { currency: "Btc", network: "Mainnet", address: "you@your-wallet.com", method: "Lightning" },
]);

test("payment request body matches the send21 API", () => {
  const { body, idempotencyKey } = buildPaymentRequest({ bookingId: 42, amountMinor: 4900, currency: "eur", title: "Intro call" }, options);
  assert.equal(idempotencyKey, "cal-booking-42");
  assert.deepEqual(
    { ...body, options: undefined },
    {
      fiatCurrency: "EUR",
      fiatAmount: 49,
      orderId: "cal-booking-42",
      memo: "Intro call",
      expiryHours: 24,
      declineNote: "The booking is released and the time slot opens for someone else.",
      reuseOpenForOrder: true,
      options: undefined,
    }
  );
  assert.equal(body.options.length, 2);
});

test("expiryHours is clamped to 1..720", () => {
  assert.equal(buildPaymentRequest({ bookingId: 1, amountMinor: 100, currency: "USD", expiryHours: 0 }, options).body.expiryHours, 1);
  assert.equal(buildPaymentRequest({ bookingId: 1, amountMinor: 100, currency: "USD", expiryHours: 9999 }, options).body.expiryHours, 720);
});

test("zero-decimal currencies are not divided", () => {
  assert.equal(toMajorUnits(5000, "JPY"), 5000);
  assert.equal(toMajorUnits(1999, "SEK"), 19.99);
  assert.throws(() => toMajorUnits(0, "EUR"));
});

test("declineNote is plain text and at most 200 characters", () => {
  assert.equal(cleanDeclineNote("<b>Slot</b>   is   released"), "Slot is released");
  assert.equal(cleanDeclineNote("x".repeat(500)).length, 200);
  assert.equal(cleanDeclineNote(""), "The booking is released and the time slot opens for someone else.");
});

test("receive options are validated", () => {
  assert.throws(() => parseReceiveOptions([]), /at least one/);
  assert.throws(() => parseReceiveOptions([{ currency: "Doge", network: "Base", address: "0x1" }]), /unknown currency/);
  assert.throws(() => parseReceiveOptions([{ currency: "Usdc", network: "Base", address: "" }]), /address/);
});

test("pay link is https://send21.io + payPath", () => {
  assert.equal(payLinkFromPath("/pay/abc"), "https://send21.io/pay/abc");
  assert.throws(() => payLinkFromPath(undefined as unknown as string));
});

const secret = "whsec_test_only_not_a_real_secret";
const raw = readFileSync(new URL("./fixtures/draft-confirmed.json", import.meta.url));

test("X-Send21-Signature-V2 verifies, with a 5-minute window", () => {
  const now = 1_790_000_000;
  const header = signV2(raw, "dlv_1", now, secret);
  assert.equal(verifySignatureV2(raw, header, "dlv_1", secret, now + 10), true);
  assert.equal(verifySignatureV2(raw, header, "dlv_1", secret, now + 301), false, "too old");
  assert.equal(verifySignatureV2(raw, header, "dlv_2", secret, now), false, "delivery id is signed");
  assert.equal(verifySignatureV2(Buffer.concat([raw, Buffer.from(" ")]), header, "dlv_1", secret, now), false, "body is signed");
  assert.equal(verifySignatureV2(raw, header, "dlv_1", "wrong", now), false);
  assert.equal(verifySignatureV2(raw, undefined, "dlv_1", secret, now), false);
  assert.equal(verifySignatureV2(raw, "t=abc,v1=zz", "dlv_1", secret, now), false);
});

const payment = { externalId: "8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b", success: false, amountMinor: 4600, currency: "EUR", bookingId: 1042 };

test("draft.confirmed with the right order and price confirms the booking", () => {
  const { event, data } = JSON.parse(raw.toString());
  const d = decide(event, data, payment);
  assert.equal(d.action, "confirm");
  assert.equal(d.action === "confirm" && d.txId, "5KqZ9bQ...");
});

test("draft.confirmed with another price goes to review, another order is ignored", () => {
  const { event, data } = JSON.parse(raw.toString());
  assert.equal(decide(event, { ...data, fiatAmount: 10 }, payment).action, "review");
  assert.equal(decide(event, { ...data, orderId: "cal-booking-7" }, payment).action, "ignore");
  assert.equal(decide(event, { ...data, paymentRequestId: "other" }, payment).action, "ignore");
  assert.equal(decide(event, data, { ...payment, success: true }).action, "ignore");
});

test("payment_request.expired releases an unpaid booking", () => {
  const data = { paymentRequestId: payment.externalId, orderId: "cal-booking-1042", opened: true, quoteRequested: false };
  assert.equal(decide("payment_request.expired", data, payment).action, "release");
  assert.equal(decide("payment_request.expired", data, { ...payment, success: true }).action, "ignore");
  assert.equal(decide("payment_request.expired", { ...data, reviewState: "pending" }, payment).action, "review");
});

test("a differing amount waits for the owner", () => {
  assert.equal(decide("draft.amount_mismatch", { paymentRequestId: payment.externalId, orderId: "cal-booking-1042" }, payment).action, "review");
});

test("handled delivery ids are remembered (send21 does not dedupe)", () => {
  let handled = rememberDelivery([], "dlv_1");
  assert.equal(alreadyHandled(handled, "dlv_1"), true);
  assert.equal(alreadyHandled(handled, "dlv_2"), false);
  for (let i = 0; i < 60; i++) handled = rememberDelivery(handled, `d${i}`);
  assert.equal(handled.length, 50);
});
