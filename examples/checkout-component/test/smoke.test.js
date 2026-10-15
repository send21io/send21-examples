import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startShop, json } from "./helpers.js";

test("mock mode smoke: page, order, pay link, idempotent retry, simulated payment, paid", async (t) => {
  const shop = await startShop({ SEND21_WEBHOOK_SECRET: "" }); // mock mode makes its own secret
  t.after(shop.close);
  assert.equal(shop.config.dryRun, true);

  const page = await fetch(`${shop.base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /send21-checkout\.js/);
  const mod = await fetch(`${shop.base}/send21-checkout.js`);
  assert.match(mod.headers.get("content-type"), /javascript/);
  assert.match(await mod.text(), /customElements\.define\("send21-checkout"/);
  assert.equal((await fetch(`${shop.base}/../server.js`)).status, 404);
  assert.equal((await fetch(`${shop.base}/%2e%2e/server.js`)).status, 404);

  const { products } = (await json(`${shop.base}/products`)).body;
  assert.ok(products.length >= 3);

  // The browser cannot set prices: unknown sku and bad qty are refused, the total is computed server-side.
  assert.equal((await json(`${shop.base}/orders`, { items: [{ sku: "nope", qty: 1 }] })).status, 400);
  const order = (await json(`${shop.base}/orders`, { items: [{ sku: "tee-21", qty: 1 }, { sku: "stickers", qty: 2 }], price: 0.01 })).body;
  assert.equal(order.fiatAmount, 38);
  assert.equal(order.fiatCurrency, "EUR");

  // A page showing another amount is refused.
  assert.equal((await json(`${shop.base}/checkout`, { orderId: order.orderId, amount: 1 })).status, 409);
  assert.equal((await json(`${shop.base}/checkout`, { orderId: order.orderId, amount: 38, currency: "USD" })).status, 409);
  assert.equal((await json(`${shop.base}/checkout`, { orderId: "ord_0000000000000000" })).status, 404);

  const first = await json(`${shop.base}/checkout`, { orderId: order.orderId, amount: 38, currency: "EUR", options: [{ currency: "Usdc", network: "Solana", address: "attacker" }] });
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "awaiting_payment");
  assert.match(first.body.payUrl, /\/mock\/pay\/[A-Za-z0-9_-]+$/);
  assert.ok(first.body.assets.some((a) => a.label === "USDT on Solana"));
  assert.ok(first.body.assets.every((a) => !("address" in a)), "no addresses in the browser view");
  const stored = shop.store.getOrder(order.orderId);
  assert.ok(stored.options.every((o) => o.address !== "attacker"), "addresses come from the server config");
  assert.match(stored.idempotencyKey, new RegExp(`^checkout-${order.orderId}-`));

  // Retrying returns the same pay link.
  const again = await json(`${shop.base}/checkout`, { orderId: order.orderId, amount: 38 });
  assert.equal(again.body.payUrl, first.body.payUrl);
  assert.equal(shop.store.getOrder(order.orderId).paymentRequestId, stored.paymentRequestId);

  const s = await json(`${shop.base}/checkout/${order.orderId}/status`);
  assert.equal(s.body.status, "awaiting_payment");

  // Mock pay page and simulated payments.
  const token = first.body.payUrl.split("/").at(-1);
  assert.equal((await fetch(first.body.payUrl)).status, 200);
  const wrong = await json(`${shop.base}/mock/pay/${token}/simulate`, { outcome: "wrong-amount" });
  assert.equal(wrong.body.outcome, "mismatch");
  const wrongAsset = await json(`${shop.base}/mock/pay/${token}/simulate`, { outcome: "wrong-asset" });
  assert.equal(wrongAsset.body.outcome, "mismatch");
  assert.equal((await json(`${shop.base}/checkout/${order.orderId}/status`)).body.status, "awaiting_payment");
  const paid = await json(`${shop.base}/mock/pay/${token}/simulate`, { outcome: "confirmed", asset: 1 });
  assert.equal(paid.body.webhookStatus, 200);
  assert.equal(paid.body.outcome, "order_paid");
  const final = (await json(`${shop.base}/checkout/${order.orderId}/status`)).body;
  assert.equal(final.status, "paid");
  assert.match(final.txId, /^mock-/);
  assert.equal(shop.store.getOrder(order.orderId).paidWith.currency, "USDT");
});

test("expired pay link: the next checkout gets a new Idempotency-Key and a new link", async (t) => {
  const shop = await startShop();
  t.after(shop.close);
  const order = (await json(`${shop.base}/orders`, { items: [{ sku: "mug-21", qty: 1 }] })).body;
  const first = (await json(`${shop.base}/checkout`, { orderId: order.orderId })).body;
  const key1 = shop.store.getOrder(order.orderId).idempotencyKey;
  const token = first.payUrl.split("/").at(-1);
  assert.equal((await json(`${shop.base}/mock/pay/${token}/simulate`, { outcome: "expired" })).body.outcome, "expired");
  const second = (await json(`${shop.base}/checkout`, { orderId: order.orderId })).body;
  assert.equal(second.status, "awaiting_payment");
  assert.notEqual(second.payUrl, first.payUrl);
  assert.notEqual(shop.store.getOrder(order.orderId).idempotencyKey, key1);
  assert.equal(shop.store.getOrder(order.orderId).paymentRequestIds.length, 2);
});

test("live mode sends the documented request to send21 with the key only from the server", async (t) => {
  const calls = [];
  const fake = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "application/json" });
    const b = calls.find((c) => c.method === "POST").body;
    res.end(JSON.stringify({ id: "8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b", shareToken: "tok", payPath: "/pay/tok", orderId: b.orderId, fiatCurrency: b.fiatCurrency, fiatAmount: b.fiatAmount, status: req.method === "POST" ? "Open" : "Expired", expiresAt: new Date(Date.now() + 3600_000).toISOString(), options: b.options }));
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  t.after(() => fake.close());
  const shop = await startShop({
    DRY_RUN: "", SEND21_API_KEY: "s21_test_key", SEND21_API_BASE: `http://127.0.0.1:${fake.address().port}`,
    SEND21_OPTIONS: "Usdc:Solana:ShopSolAddr,Usdt:Ethereum:0xShopEthAddr",
  });
  t.after(shop.close);
  assert.equal(shop.config.dryRun, false);
  const order = (await json(`${shop.base}/orders`, { items: [{ sku: "mug-21", qty: 1 }] })).body;
  const view = (await json(`${shop.base}/checkout`, { orderId: order.orderId, amount: 18 })).body;
  assert.equal(view.payUrl, `http://127.0.0.1:${fake.address().port}/pay/tok`);
  assert.equal(JSON.stringify(view).includes("s21_test_key"), false);

  const post = calls[0];
  assert.equal(post.url, "/api/v1/payment-requests");
  assert.equal(post.headers.authorization, "Bearer s21_test_key");
  assert.match(post.headers["idempotency-key"], new RegExp(`^checkout-${order.orderId}-[0-9a-f-]{36}$`));
  assert.deepEqual(post.body, {
    fiatCurrency: "EUR", fiatAmount: 18, orderId: order.orderId, memo: `Order ${order.orderId}`, expiryHours: 1, reuseOpenForOrder: true,
    options: [{ currency: "Usdc", network: "Solana", address: "ShopSolAddr" }, { currency: "Usdt", network: "Ethereum", address: "0xShopEthAddr" }],
  });

  // Status read: GET /payment-requests/{id}, Expired -> expired.
  const s = (await json(`${shop.base}/checkout/${order.orderId}/status`)).body;
  assert.equal(calls[1].url, "/api/v1/payment-requests/8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b");
  assert.equal(s.status, "expired");
});

test("live mode refuses to start without a webhook secret or receive options", () => {
  return import("../server.js").then(({ loadConfig }) => {
    assert.throws(() => loadConfig({ SEND21_API_KEY: "s21_x", SEND21_OPTIONS: "Usdc:Solana:A" }), /SEND21_WEBHOOK_SECRET/);
    assert.throws(() => loadConfig({ SEND21_API_KEY: "s21_x", SEND21_WEBHOOK_SECRET: "s" }), /SEND21_OPTIONS/);
  });
});
