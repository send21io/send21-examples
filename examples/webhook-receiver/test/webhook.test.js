import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sign, verifySignature } from "../verify.js";
import { createWebhookServer, handleEvent } from "../server.js";
import { amountMismatchBody as mismatch, confirmedAcceptedBody as confirmedAccepted, confirmedBody as confirmed, testBody } from "../samples.js";

const secret = randomBytes(32).toString("hex");

test("accepts a valid signature over the raw body", () => {
  assert.equal(verifySignature(Buffer.from(confirmed), sign(confirmed, secret), secret), true);
  assert.equal(verifySignature(Buffer.from(mismatch), sign(mismatch, secret), secret), true);
});

test("sign matches the documented check: sha256= plus lowercase hex HMAC-SHA256 of the raw body", () => {
  // The snippet from the Webhooks section of https://send21.io/swagger.
  const expected = "sha256=" + createHmac("sha256", secret).update(mismatch).digest("hex");
  const header = sign(mismatch, secret);
  assert.equal(header, expected);
  assert.match(header, /^sha256=[0-9a-f]{64}$/);
  assert.equal(timingSafeEqual(Buffer.from(expected), Buffer.from(header)), true);
});

test("rejects an uppercase hex digest, the documented format is lowercase", () => {
  const header = "sha256=" + sign(confirmed, secret).slice(7).toUpperCase();
  assert.equal(verifySignature(confirmed, header, secret), false);
});

test("rejects a tampered body", () => {
  const tampered = mismatch.replace('"receivedAmountSats": 49250000', '"receivedAmountSats": 50000000');
  assert.notEqual(tampered, mismatch);
  assert.equal(verifySignature(tampered, sign(mismatch, secret), secret), false);
});

test("rejects a re-serialized body with different bytes", () => {
  const compact = JSON.stringify(JSON.parse(mismatch));
  assert.equal(verifySignature(compact, sign(mismatch, secret), secret), false);
});

test("rejects the wrong secret", () => {
  assert.equal(verifySignature(confirmed, sign(confirmed, "other-secret"), secret), false);
});

test("rejects missing, unprefixed and malformed headers without throwing", () => {
  const hex = sign(confirmed, secret).slice(7);
  for (const header of [undefined, "", hex, "sha1=" + hex, "sha256=", "sha256=zz" + hex.slice(2), "sha256=" + hex + "00", ["sha256=" + hex]]) {
    assert.equal(verifySignature(confirmed, header, secret), false, `header ${header}`);
  }
});

test("rejects when no secret is configured", () => {
  assert.equal(verifySignature(confirmed, sign(confirmed, ""), ""), false);
});

test("draft.amount_mismatch sample has the documented payload shape", () => {
  const { event, data } = JSON.parse(mismatch);
  assert.equal(event, "draft.amount_mismatch");
  for (const key of [
    "draftId", "status", "txId", "confirmations", "receivedAmountSats", "receivedAmount", "sentCurrency", "network",
    "amountSats", "sentAmount", "fiatCurrency", "fiatAmount", "conversionRate", "rateSource", "platformFee",
    "paymentRequestId", "orderId", "occurredAt",
  ]) {
    assert.ok(key in data, `missing ${key}`);
  }
  assert.equal(data.status, "AwaitingPayment");
  assert.notEqual(data.receivedAmountSats, data.amountSats);
  assert.ok(Math.abs(data.amountSats - data.receivedAmountSats) <= data.amountSats * 0.1, "within 10% of the billed amount");
  assert.deepEqual(Object.keys(data.platformFee), ["accrued", "waived", "percent", "feeUsd", "feeBaseUnits", "feeAmount", "currency"]);

  // A normal draft.confirmed carries the same fields, without the received amounts.
  const confirmedData = JSON.parse(confirmed).data;
  assert.equal("receivedAmountSats" in confirmedData, false);
  assert.equal("receivedAmount" in confirmedData, false);
});

test("handleEvent marks draft.confirmed paid", () => {
  const lines = [];
  assert.equal(handleEvent(JSON.parse(confirmed), (l) => lines.push(l)), "order_paid");
  assert.match(lines[0], /order=ORDER-1042/);
  assert.match(lines[0], /50\.000000 USDC on Solana/);
});

test("draft.confirmed after an accepted different amount carries the received amounts", () => {
  // Derived from the docs: receivedAmountSats and receivedAmount are set on the
  // draft.confirmed of an accepted short or over payment.
  const { event, data } = JSON.parse(confirmedAccepted);
  assert.equal(event, "draft.confirmed");
  assert.equal(data.receivedAmountSats, 49250000);
  assert.equal(data.receivedAmount, "49.250000");
  assert.notEqual(data.receivedAmountSats, data.amountSats);
  const { receivedAmountSats, receivedAmount, occurredAt, ...rest } = data;
  const { occurredAt: _, ...normal } = JSON.parse(confirmed).data;
  assert.deepEqual(rest, normal, "same fields as a normal draft.confirmed plus the received amounts");
});

test("handleEvent marks an accepted different amount paid and logs what arrived", () => {
  const lines = [];
  assert.equal(handleEvent(JSON.parse(confirmedAccepted), (l) => lines.push(l)), "order_paid");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /paid \(different amount accepted\)/);
  assert.match(lines[0], /order=ORDER-1042/);
  assert.match(lines[0], /received 49\.250000 USDC \(49250000 base units\), billed 50\.000000 USDC on Solana/);

  // Only receivedAmountSats present still counts as a different amount.
  const onlySats = JSON.parse(confirmedAccepted);
  delete onlySats.data.receivedAmount;
  lines.length = 0;
  assert.equal(handleEvent(onlySats, (l) => lines.push(l)), "order_paid");
  assert.match(lines[0], /different amount accepted/);

  // A normal confirmation does not mention a different amount.
  lines.length = 0;
  handleEvent(JSON.parse(confirmed), (l) => lines.push(l));
  assert.doesNotMatch(lines[0], /different amount/);
});

test("handleEvent flags draft.amount_mismatch for review with received and billed amounts", () => {
  const lines = [];
  assert.equal(handleEvent(JSON.parse(mismatch), (l) => lines.push(l)), "needs_review");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /needs review/);
  assert.match(lines[0], /order=ORDER-1042 draft=3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c/);
  assert.match(lines[0], /received 49\.250000 USDC, billed 50\.000000 USDC on Solana/);
  assert.match(lines[0], /tx=5KqZ9bQ\.\.\. confirmations=1/);
  assert.doesNotMatch(lines[0], /platformFee/);
});

test("handleEvent handles draft.seen, test and ignores other events", () => {
  const lines = [];
  const log = (l) => lines.push(l);
  const seen = { event: "draft.seen", data: { ...JSON.parse(mismatch).data, status: "Seen", acceptedByOwner: true } };
  // draft.seen with acceptedByOwner does not mark the order paid; draft.confirmed follows.
  assert.equal(handleEvent(seen, log), "payment_seen");
  assert.notEqual(handleEvent(seen, log), "order_paid");
  assert.match(lines[0], /accepted by owner/);
  assert.equal(handleEvent(JSON.parse(testBody), log), "test");
  for (const event of ["draft.created", "draft.expired", "draft.cancelled"]) {
    assert.equal(handleEvent({ event, data: {} }, log), "ignored");
  }
});

test("HTTP server verifies signatures, handles events and ignores repeated deliveries", async (t) => {
  const server = createWebhookServer({ secret, log: () => {} });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/webhooks/send21`;
  const post = (body, { event, delivery = randomUUID(), signature = sign(body, secret) } = {}) => {
    const headers = { "content-type": "application/json", "X-Send21-Delivery": delivery };
    if (event) headers["X-Send21-Event"] = event;
    if (signature !== null) headers["X-Send21-Signature"] = signature;
    return fetch(url, { method: "POST", headers, body });
  };

  let res = await post(confirmed, { event: "draft.confirmed" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });

  // A retry reuses X-Send21-Delivery and must not be handled twice.
  const delivery = randomUUID();
  res = await post(mismatch, { event: "draft.amount_mismatch", delivery });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "needs_review" });
  res = await post(mismatch, { event: "draft.amount_mismatch", delivery });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "duplicate" });

  res = await post(confirmedAccepted, { event: "draft.confirmed" });
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });

  res = await post(testBody, { event: "test" });
  assert.deepEqual(await res.json(), { ok: true, outcome: "test" });

  // A rejected delivery is not remembered, so a correctly signed retry is handled.
  const retried = randomUUID();
  res = await post(confirmed, { delivery: retried, signature: null });
  assert.equal(res.status, 401);
  res = await post(confirmed, { delivery: retried, signature: sign(mismatch, secret) });
  assert.equal(res.status, 401);
  res = await post(confirmed, { delivery: retried });
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });

  res = await post("not json");
  assert.equal(res.status, 400);

  res = await fetch(url.replace("/webhooks/send21", "/other"), { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
});
