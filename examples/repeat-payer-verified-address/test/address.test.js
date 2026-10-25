import test from "node:test";
import assert from "node:assert/strict";
import { chunk, compareAddresses } from "../lib/address.js";
import { addressChecks } from "../lib/monthly.js";
import { signV2, verifyV2 } from "../lib/webhook.js";

const approved = "HYKwDo4ZMFoTo2yCLpgeKq8quErCXu1sL8rHPgSknsv7";
// A lookalike: same first 4 and last 4 characters, different middle.
const lookalike = "HYKwQ1x9ZtLmPn3RsVb7Ck2DfGh8JqW5eYa6TuNnsv7";

test("chunks an address in groups of four", () => {
  assert.deepEqual(chunk("abcdefghij"), ["abcd", "efgh", "ij"]);
});

test("a lookalike with the same start and end does not match", () => {
  const r = compareAddresses(approved, lookalike);
  assert.equal(r.match, false);
  assert.equal(r.firstDifferenceAt, 4);
});

test("addressChecks covers the draft, tx-template and paymentUri", () => {
  const draft = { receiverAddress: approved, paymentUri: `solana:${approved}?amount=5&spl-token=x` };
  const ok = addressChecks(approved, draft, { outputs: [{ address: approved }] });
  assert.equal(ok.allMatch, true);
  assert.equal(ok.checks.length, 3);
  const bad = addressChecks(approved, { ...draft, paymentUri: `solana:${lookalike}?amount=5` }, { outputs: [{ address: approved }] });
  assert.equal(bad.allMatch, false);
});

test("webhook V2 signature: valid, tampered and stale", () => {
  const rawBody = Buffer.from('{"event":"test","data":{}}');
  const sig = signV2({ rawBody, deliveryId: "d1", secret: "s" });
  assert.equal(verifyV2({ rawBody, signatureHeader: sig, deliveryId: "d1", secret: "s" }), true);
  assert.equal(verifyV2({ rawBody, signatureHeader: sig, deliveryId: "d2", secret: "s" }), false);
  const old = signV2({ rawBody, deliveryId: "d1", secret: "s", t: Math.floor(Date.now() / 1000) - 600 });
  assert.equal(verifyV2({ rawBody, signatureHeader: old, deliveryId: "d1", secret: "s" }), false);
});
