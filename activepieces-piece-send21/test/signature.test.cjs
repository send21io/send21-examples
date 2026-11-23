const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { signV2, verifySignatureV2 } = require("../lib-dist/src/lib/common/signature.js");

const secret = "test-webhook-secret";
const deliveryId = "delivery-1";
const body = Buffer.from(
  JSON.stringify({
    event: "draft.confirmed",
    data: { draftId: "3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c", status: "Confirmed" },
  })
);

describe("verifySignatureV2", () => {
  it("accepts a fresh V2 signature", () => {
    const now = 1_700_000_000;
    const header = signV2(body, deliveryId, now, secret);
    assert.equal(verifySignatureV2(body, header, deliveryId, secret, { now }), true);
  });

  it("rejects a signature older than 5 minutes", () => {
    const sent = 1_700_000_000;
    const header = signV2(body, deliveryId, sent, secret);
    assert.equal(verifySignatureV2(body, header, deliveryId, secret, { now: sent + 301 }), false);
  });

  it("rejects a different delivery id or tampered body", () => {
    const now = 1_700_000_000;
    const header = signV2(body, deliveryId, now, secret);
    assert.equal(verifySignatureV2(body, header, "other", secret, { now }), false);
    assert.equal(
      verifySignatureV2(Buffer.from('{"event":"forged"}'), header, deliveryId, secret, { now }),
      false
    );
  });
});
