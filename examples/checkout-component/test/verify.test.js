import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { signV2, verifySignatureV2 } from "../lib/verify.js";

const secret = "whsec_test_secret";
const body = JSON.stringify({ event: "draft.confirmed", data: { orderId: "ord_1", fiatAmount: 40.5 } });
const now = 1_760_000_000;

test("valid V2 signature is accepted", () => {
  const d = randomUUID();
  assert.equal(verifySignatureV2(body, signV2(body, d, now, secret), d, secret, { now }), true);
  assert.equal(verifySignatureV2(Buffer.from(body), signV2(body, d, now, secret), d, secret, { now: now + 299 }), true);
});

test("tampered body, signature, delivery id or secret is refused", () => {
  const d = randomUUID();
  const sig = signV2(body, d, now, secret);
  assert.equal(verifySignatureV2(body.replace("40.5", "4.05"), sig, d, secret, { now }), false);
  const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
  assert.equal(verifySignatureV2(body, flipped, d, secret, { now }), false);
  assert.equal(verifySignatureV2(body, sig, randomUUID(), secret, { now }), false);
  assert.equal(verifySignatureV2(body, sig, d, "other-secret", { now }), false);
  // Moving the signature to another timestamp breaks it too.
  assert.equal(verifySignatureV2(body, sig.replace(`t=${now}`, `t=${now + 1}`), d, secret, { now }), false);
});

test("a delivery 301 s old (or 301 s in the future) is refused", () => {
  const d = randomUUID();
  assert.equal(verifySignatureV2(body, signV2(body, d, now - 301, secret), d, secret, { now }), false);
  assert.equal(verifySignatureV2(body, signV2(body, d, now + 301, secret), d, secret, { now }), false);
  assert.equal(verifySignatureV2(body, signV2(body, d, now - 300, secret), d, secret, { now }), true);
});

test("missing or malformed headers return false instead of throwing", () => {
  const d = randomUUID();
  for (const header of [undefined, "", "t=abc,v1=00", `t=${now}`, `v1=${"a".repeat(64)}`, `t=${now},v1=${"a".repeat(63)}`, ["x"]]) {
    assert.equal(verifySignatureV2(body, header, d, secret, { now }), false);
  }
  assert.equal(verifySignatureV2(body, signV2(body, d, now, secret), undefined, secret, { now }), false);
  assert.equal(verifySignatureV2(body, signV2(body, d, now, secret), d, "", { now }), false);
});
