import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sign, verifySignature } from "../verify.js";
import { createWebhookServer, handleEvent } from "../server.js";

const secret = randomBytes(32).toString("hex");
const confirmed = JSON.stringify({
  event: "draft.confirmed",
  data: {
    draftId: "7d21aaaa-0000-0000-0000-000000000000",
    status: "Confirmed",
    txId: "3QzV",
    confirmations: 1,
    sentCurrency: "USDC",
    network: "Solana",
    sentAmount: "53.870000",
    fiatCurrency: "EUR",
    fiatAmount: 49.9,
    conversionRate: 0.9263,
    rateSource: "coinbase",
    orderId: "shop-order-1042",
  },
});
const mismatch = JSON.stringify({
  event: "draft.amount_mismatch",
  data: { draftId: "7d21bbbb-0000-0000-0000-000000000000", orderId: "shop-order-1043" },
});

test("accepts a valid signature over the raw body", () => {
  assert.equal(verifySignature(Buffer.from(confirmed), sign(confirmed, secret), secret), true);
});

test("accepts an uppercase hex digest", () => {
  const header = "sha256=" + sign(confirmed, secret).slice(7).toUpperCase();
  assert.equal(verifySignature(confirmed, header, secret), true);
});

test("rejects a tampered body", () => {
  const tampered = confirmed.replace("53.870000", "99.870000");
  assert.equal(verifySignature(tampered, sign(confirmed, secret), secret), false);
});

test("rejects a re-serialized body with different bytes", () => {
  const pretty = JSON.stringify(JSON.parse(confirmed), null, 2);
  assert.equal(verifySignature(pretty, sign(confirmed, secret), secret), false);
});

test("rejects the wrong secret", () => {
  assert.equal(verifySignature(confirmed, sign(confirmed, "other-secret"), secret), false);
});

test("rejects missing, unprefixed and malformed headers", () => {
  const hex = sign(confirmed, secret).slice(7);
  for (const header of [undefined, "", hex, "sha1=" + hex, "sha256=", "sha256=zz" + hex.slice(2), "sha256=" + hex + "00"]) {
    assert.equal(verifySignature(confirmed, header, secret), false, `header ${header}`);
  }
});

test("rejects when no secret is configured", () => {
  assert.equal(verifySignature(confirmed, sign(confirmed, ""), ""), false);
});

test("handleEvent routes the two events", () => {
  const lines = [];
  assert.equal(handleEvent(JSON.parse(confirmed), (l) => lines.push(l)), "order_paid");
  assert.equal(handleEvent(JSON.parse(mismatch), (l) => lines.push(l)), "needs_review");
  assert.equal(handleEvent({ event: "draft.seen", data: {} }, (l) => lines.push(l)), "ignored");
  assert.match(lines[0], /order=shop-order-1042/);
  assert.match(lines[1], /needs review/);
});

test("HTTP server verifies signatures and handles events", async (t) => {
  const server = createWebhookServer({ secret, log: () => {} });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/webhooks/send21`;
  const post = (body, headers = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  let res = await post(confirmed, { "x-send21-signature": sign(confirmed, secret) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });

  res = await post(mismatch, { "X-Send21-Signature": sign(mismatch, secret) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "needs_review" });

  res = await post(confirmed);
  assert.equal(res.status, 401);

  res = await post(confirmed, { "x-send21-signature": sign(mismatch, secret) });
  assert.equal(res.status, 401);

  res = await post("not json", { "x-send21-signature": sign("not json", secret) });
  assert.equal(res.status, 400);

  res = await fetch(url.replace("/webhooks/send21", "/other"), { method: "POST", body: "{}" });
  assert.equal(res.status, 404);
});
