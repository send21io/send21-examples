const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_REMEMBERED_DELIVERIES,
  isHandled,
  rememberDelivery,
} = require("../lib-dist/src/lib/common/deliveries.js");

describe("rememberDelivery", () => {
  it("records a delivery id and recognises it on retry", () => {
    const once = rememberDelivery([], "delivery-1");
    assert.equal(isHandled(once, "delivery-1"), true);
    assert.equal(isHandled(once, "delivery-2"), false);
    const twice = rememberDelivery(once, "delivery-1");
    assert.deepEqual(twice, ["delivery-1"]);
  });

  it("keeps only the last 200 ids", () => {
    let list = [];
    for (let i = 0; i < MAX_REMEMBERED_DELIVERIES + 5; i++) {
      list = rememberDelivery(list, `d-${i}`);
    }
    assert.equal(list.length, MAX_REMEMBERED_DELIVERIES);
    assert.equal(isHandled(list, "d-0"), false);
    assert.equal(isHandled(list, "d-5"), true);
    assert.equal(isHandled(list, `d-${MAX_REMEMBERED_DELIVERIES + 4}`), true);
  });
});
