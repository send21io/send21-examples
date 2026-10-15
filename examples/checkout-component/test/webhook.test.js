import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startShop, json, postWebhook, confirmedFor, SECRET } from "./helpers.js";

async function shopWithOpenOrder(t) {
  const shop = await startShop();
  t.after(shop.close);
  const order = (await json(`${shop.base}/orders`, { items: [{ sku: "mug-21", qty: 2 }, { sku: "stickers", qty: 1 }] })).body;
  await json(`${shop.base}/checkout`, { orderId: order.orderId, amount: order.fiatAmount, currency: order.fiatCurrency });
  const stored = shop.store.getOrder(order.orderId);
  return { shop, order, stored };
}

const status = async (shop, orderId) => (await json(`${shop.base}/checkout/${orderId}/status`)).body;

test("valid draft.confirmed marks the order paid with the txId", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const res = await postWebhook(shop.base, confirmedFor(order, stored));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });
  const s = await status(shop, order.orderId);
  assert.equal(s.status, "paid");
  assert.equal(s.txId, "5KqZ9bQtest");
});

test("tampered body is refused with 401 and changes nothing", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const res = await postWebhook(shop.base, confirmedFor(order, stored), { tamper: (raw) => raw.replace('"txId":"5KqZ9bQtest"', '"txId":"evil"') });
  assert.equal(res.status, 401);
  assert.equal((await status(shop, order.orderId)).status, "awaiting_payment");
  // Wrong secret, missing header.
  assert.equal((await postWebhook(shop.base, confirmedFor(order, stored), { secret: "nope" })).status, 401);
  const bare = await fetch(`${shop.base}/webhooks/send21`, { method: "POST", headers: { "x-send21-delivery": randomUUID() }, body: "{}" });
  assert.equal(bare.status, 401);
});

test("a delivery signed 301 s ago is refused", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const res = await postWebhook(shop.base, confirmedFor(order, stored), { timestamp: Math.floor(Date.now() / 1000) - 301 });
  assert.equal(res.status, 401);
  assert.equal((await status(shop, order.orderId)).status, "awaiting_payment");
});

test("a duplicate delivery (same X-Send21-Delivery) is acknowledged but not applied again", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const delivery = randomUUID();
  const body = confirmedFor(order, stored);
  assert.equal((await (await postWebhook(shop.base, body, { delivery })).json()).outcome, "order_paid");
  const paidAt = shop.store.getOrder(order.orderId).paidAt;
  const again = await postWebhook(shop.base, { ...body, data: { ...body.data, txId: "other" } }, { delivery });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).outcome, "duplicate");
  assert.equal(shop.store.getOrder(order.orderId).txId, "5KqZ9bQtest");
  assert.equal(shop.store.getOrder(order.orderId).paidAt, paidAt);
});

test("a rejected (bad signature) delivery id is not remembered, so a valid retry still works", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const delivery = randomUUID();
  assert.equal((await postWebhook(shop.base, confirmedFor(order, stored), { delivery, secret: "wrong" })).status, 401);
  assert.equal((await (await postWebhook(shop.base, confirmedFor(order, stored), { delivery })).json()).outcome, "order_paid");
});

test("amount mismatch: a confirmation for a different fiat amount does not mark the order paid", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const res = await postWebhook(shop.base, confirmedFor(order, stored, { fiatAmount: order.fiatAmount - 5 }));
  assert.equal(res.status, 200); // acknowledged so send21 does not retry, but not applied
  assert.equal((await res.json()).outcome, "mismatch");
  assert.equal((await status(shop, order.orderId)).status, "awaiting_payment");
  const alerts = shop.store.getOrder(order.orderId).alerts;
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].problems.join(), /amount 35.5 != 40.5/);
  // One cent off is still a mismatch.
  assert.equal((await (await postWebhook(shop.base, confirmedFor(order, stored, { fiatAmount: 40.49 }))).json()).outcome, "mismatch");
});

test("currency, asset and pay-link mismatches are refused too", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const cases = [
    [{ fiatCurrency: "USD" }, /currency USD != EUR/],
    [{ sentCurrency: "USDT", network: "Polygon" }, /asset USDT on Polygon was not offered/],
    [{ sentCurrency: "ETH", network: "Ethereum" }, /asset ETH on Ethereum was not offered/],
    [{ paymentRequestId: randomUUID() }, /was not created for this order/],
    [{ status: "AwaitingPayment" }, /status is AwaitingPayment/],
  ];
  for (const [overrides, reason] of cases) {
    const r = await (await postWebhook(shop.base, confirmedFor(order, stored, overrides))).json();
    assert.equal(r.outcome, "mismatch", JSON.stringify(overrides));
    assert.match(shop.store.getOrder(order.orderId).alerts.at(-1).problems.join(), reason);
  }
  assert.equal((await status(shop, order.orderId)).status, "awaiting_payment");
  // USDT on Solana is offered (mock options), so that one pays.
  const ok = await (await postWebhook(shop.base, confirmedFor(order, stored, { sentCurrency: "USDT", network: "Solana" }))).json();
  assert.equal(ok.outcome, "order_paid");
});

test("an accepted different amount is held for review unless ACCEPT_DIFFERENT_AMOUNT=1", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const short = { receivedAmountSats: 43000000, receivedAmount: "43.000000" };
  assert.equal((await (await postWebhook(shop.base, confirmedFor(order, stored, short))).json()).outcome, "review");
  assert.equal((await status(shop, order.orderId)).status, "review");

  const shop2 = await startShop({ ACCEPT_DIFFERENT_AMOUNT: "1" });
  t.after(shop2.close);
  const o2 = (await json(`${shop2.base}/orders`, { items: [{ sku: "tee-21", qty: 1 }] })).body;
  await json(`${shop2.base}/checkout`, { orderId: o2.orderId });
  const r = await (await postWebhook(shop2.base, confirmedFor(o2, shop2.store.getOrder(o2.orderId), short))).json();
  assert.equal(r.outcome, "order_paid");
});

test("payment_request.expired marks an unpaid order expired; unknown orders are ignored", async (t) => {
  const { shop, order, stored } = await shopWithOpenOrder(t);
  const r = await (await postWebhook(shop.base, { event: "payment_request.expired", data: { paymentRequestId: stored.paymentRequestId, orderId: order.orderId, opened: true, quoteRequested: false } })).json();
  assert.equal(r.outcome, "expired");
  assert.equal((await status(shop, order.orderId)).status, "expired");
  const u = await (await postWebhook(shop.base, confirmedFor({ ...order, orderId: "ord_ffffffffffffffff" }, stored))).json();
  assert.equal(u.outcome, "unknown_order");
  assert.equal(SECRET.length > 0, true);
});
