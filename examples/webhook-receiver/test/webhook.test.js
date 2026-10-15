import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sign, signV2, verifyDelivery, verifySignature, verifySignatureV2 } from "../verify.js";
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

test("V2: signV2 matches the documented format t=<timestamp>,v1=<hex HMAC-SHA256 of \"<timestamp>.<delivery id>.<raw body>\">", () => {
  const delivery = randomUUID();
  const t = 1792046712;
  const expected = createHmac("sha256", secret).update(`${t}.${delivery}.${mismatch}`).digest("hex");
  assert.equal(signV2(mismatch, delivery, t, secret), `t=${t},v1=${expected}`);
});

test("V2: accepts a fresh delivery, refuses one older than 5 minutes or from the future", () => {
  const delivery = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifySignatureV2(confirmed, signV2(confirmed, delivery, now, secret), delivery, secret), true);
  assert.equal(verifySignatureV2(confirmed, signV2(confirmed, delivery, now - 299, secret), delivery, secret, { now }), true);
  assert.equal(verifySignatureV2(confirmed, signV2(confirmed, delivery, now - 301, secret), delivery, secret, { now }), false);
  assert.equal(verifySignatureV2(confirmed, signV2(confirmed, delivery, now + 301, secret), delivery, secret, { now }), false);
});

test("V2: rejects a changed delivery id, timestamp, body or secret, and malformed headers", () => {
  const delivery = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const header = signV2(mismatch, delivery, now, secret);
  assert.equal(verifySignatureV2(mismatch, header, randomUUID(), secret), false);
  assert.equal(verifySignatureV2(mismatch, header.replace(`t=${now}`, `t=${now - 1}`), delivery, secret), false);
  assert.equal(verifySignatureV2(JSON.stringify(JSON.parse(mismatch)), header, delivery, secret), false);
  assert.equal(verifySignatureV2(mismatch, signV2(mismatch, delivery, now, "other-secret"), delivery, secret), false);
  for (const h of [undefined, "", "t=,v1=", `t=${now}`, `v1=${header.split("v1=")[1]}`, `t=abc,v1=${header.split("v1=")[1]}`, [header]]) {
    assert.equal(verifySignatureV2(mismatch, h, delivery, secret), false, `header ${h}`);
  }
  assert.equal(verifySignatureV2(mismatch, header, undefined, secret), false);
  assert.equal(verifySignatureV2(mismatch, header, delivery, ""), false);
});

test("verifyDelivery prefers V2 and uses the legacy header only when no V2 header is sent", () => {
  const delivery = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const legacy = sign(confirmed, secret);
  const fresh = signV2(confirmed, delivery, now, secret);
  const stale = signV2(confirmed, delivery, now - 600, secret);
  assert.deepEqual(verifyDelivery(confirmed, { "x-send21-delivery": delivery, "x-send21-signature-v2": fresh, "x-send21-signature": legacy }, secret), { valid: true, scheme: "v2" });
  // A stale V2 is refused even when a valid legacy signature is present.
  assert.deepEqual(verifyDelivery(confirmed, { "x-send21-delivery": delivery, "x-send21-signature-v2": stale, "x-send21-signature": legacy }, secret), { valid: false, scheme: "v2" });
  assert.deepEqual(verifyDelivery(confirmed, { "x-send21-signature": legacy }, secret), { valid: true, scheme: "v1" });
  assert.deepEqual(verifyDelivery(confirmed, { "x-send21-signature": legacy }, secret, { allowLegacy: false }), { valid: false, scheme: null });
  assert.deepEqual(verifyDelivery(confirmed, {}, secret), { valid: false, scheme: null });
});

test("HTTP server verifies V2 deliveries and refuses stale ones", async (t) => {
  const server = createWebhookServer({ secret, log: () => {} });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/webhooks/send21`;
  const post = (body, { delivery = randomUUID(), timestamp = Math.floor(Date.now() / 1000), legacy = true } = {}) => {
    const headers = {
      "content-type": "application/json",
      "X-Send21-Delivery": delivery,
      "X-Send21-Timestamp": String(timestamp),
      "X-Send21-Signature-V2": signV2(body, delivery, timestamp, secret),
    };
    if (legacy) headers["X-Send21-Signature"] = sign(body, secret);
    return fetch(url, { method: "POST", headers, body });
  };
  let res = await post(confirmed);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });
  res = await post(confirmed, { legacy: false });
  assert.equal(res.status, 200);
  res = await post(confirmed, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(res.status, 401);
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

test("HTTP server (legacy X-Send21-Signature fallback) verifies signatures, handles events and ignores repeated deliveries", async (t) => {
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

test("handleEvent never marks the order paid on the amount review events", () => {
  const lines = [];
  const log = (l) => lines.push(l);
  const data = { draftId: "d1", orderId: "o1", receivedAmount: "9.5", sentAmount: "10", sentCurrency: "USDT" };
  assert.equal(handleEvent({ event: "draft.mismatch_accepted", data: { ...data, acceptReason: "auto: shortfallPolicy" } }, log), "mismatch_accepted");
  assert.equal(handleEvent({ event: "draft.mismatch_rejected", data: { ...data, rejectReason: "wrong order", refund: "manual" } }, log), "mismatch_rejected");
  assert.equal(handleEvent({ event: "draft.mismatch_reminder", data }, log), "needs_review");
  assert.equal(handleEvent({ event: "draft.mismatch_unresolved", data }, log), "needs_review");
  assert.match(lines[0], /reason=auto: shortfallPolicy/);
  assert.match(lines[1], /refund=manual/);
  assert.match(lines[3], /unresolved/);
});
