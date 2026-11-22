import assert from "node:assert/strict";
import { test } from "node:test";

import { createLinkForInvoice, handleInvoiceNinjaWebhook, handleSend21Webhook } from "../src/handlers.js";
import { invoiceNinjaClient } from "../src/invoiceninja.js";
import { buildPaymentRequest, cleanDeclineNote, parseReceiveOptions, signV2, verifySignatureV2 } from "../src/send21.js";
import { memoryStore } from "../src/store.js";

const SECRET = "whsec_test_only_not_a_real_secret";
const options = parseReceiveOptions('[{"currency":"Usdc","network":"Base","address":"0xReceiver"}]');
const config = {
  send21ApiKey: "s21_test_only",
  send21WebhookSecret: SECRET,
  options,
  invoiceNinjaWebhookToken: "in_token_test_only",
  linkField: "custom_value1",
  currency: undefined,
};

/** Fake fetch for both APIs; records calls. */
function fakeFetch() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url === "https://send21.io/api/v1/payment-requests") return json(201, { id: "pr_1", payPath: "/pay/abc" });
    if (url.endsWith("/api/v1/invoices/Inv42") && (init.method ?? "GET") === "GET")
      return json(200, { data: { id: "Inv42", number: "0042", client_id: "Cl7", balance: 46, amount: 46 } });
    if (url.endsWith("/api/v1/clients/Cl7")) return json(200, { data: { id: "Cl7", settings: { currency_id: "3" } } });
    if (url.endsWith("/api/v1/statics")) return json(200, { currencies: [{ id: "1", code: "USD" }, { id: "3", code: "EUR" }] });
    if (url.endsWith("/api/v1/invoices/Inv42")) return json(200, { data: { id: "Inv42" } });
    if (url.endsWith("/api/v1/payments")) return json(200, { data: { id: "Pay1" } });
    return json(404, {});
  };
  fn.calls = calls;
  return fn;
}

function setup() {
  const fetchImpl = fakeFetch();
  const store = memoryStore();
  const api = invoiceNinjaClient({ baseUrl: "https://in.example.com/", token: "in_api_test_only", fetchImpl });
  return { fetchImpl, store, deps: { config, api, store, fetchImpl } };
}

const confirmed = (over = {}) => ({
  event: "draft.confirmed",
  data: {
    draftId: "3f6c2a9e", quoteId: "9b2e7c41", txId: "5KqZ9bQ...", sentCurrency: "USDC", network: "Solana", sentAmount: "50.000000",
    fiatCurrency: "EUR", fiatAmount: 46, conversionRate: 0.92, rateSource: "coinbase", paymentRequestId: "pr_1",
    orderId: "invoiceninja-Inv42", confirmedAt: "2026-10-06T08:22:21.000Z", ...over,
  },
});

function signed(payload, deliveryId, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  const body = Buffer.from(JSON.stringify(payload));
  return { body, headers: { "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(body, deliveryId, t, secret) } };
}

test("payment request body and idempotency key", () => {
  const r = buildPaymentRequest({ invoiceId: "Inv42", number: "0042", balance: "46.004", currency: "EUR" }, options, { expiryHours: 0 });
  assert.equal(r.idempotencyKey, "invoiceninja-Inv42-46.00");
  assert.equal(r.body.fiatAmount, 46);
  assert.equal(r.body.orderId, "invoiceninja-Inv42");
  assert.equal(r.body.reuseOpenForOrder, true);
  assert.equal(r.body.expiryHours, 24);
  assert.throws(() => buildPaymentRequest({ invoiceId: "x", balance: 0, currency: "EUR" }, options));
  assert.equal(cleanDeclineNote("y".repeat(300)).length, 200);
});

test("create-link: pay link for the open balance, written to the invoice custom field", async () => {
  const { fetchImpl, deps } = setup();
  const link = await createLinkForInvoice("Inv42", deps);
  assert.equal(link, "https://send21.io/pay/abc");
  const pr = fetchImpl.calls.find((c) => c.url.startsWith("https://send21.io"));
  assert.equal(pr.headers["Idempotency-Key"], "invoiceninja-Inv42-46.00");
  assert.equal(pr.body.fiatCurrency, "EUR", "currency looked up from the client via /statics");
  const put = fetchImpl.calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body, { custom_value1: "https://send21.io/pay/abc" });
  assert.equal(put.headers["X-API-TOKEN"], "in_api_test_only");
});

test("Invoice Ninja webhook needs the shared token", async () => {
  const { deps } = setup();
  const body = Buffer.from(JSON.stringify({ id: "Inv42" }));
  assert.equal((await handleInvoiceNinjaWebhook({ headers: {}, body }, deps)).status, 401);
  assert.equal((await handleInvoiceNinjaWebhook({ headers: { "x-webhook-token": "in_token_test_only" }, body }, deps)).status, 200);
});

test("draft.confirmed records one Crypto payment; a retry is ignored", async () => {
  const { fetchImpl, deps } = setup();
  await createLinkForInvoice("Inv42", deps);
  const req = signed(confirmed(), "dlv_1");
  const first = await handleSend21Webhook(req, deps);
  assert.equal(first.status, 200);
  assert.equal(JSON.parse(first.body).action, "paid");
  const payments = () => fetchImpl.calls.filter((c) => c.url.endsWith("/payments"));
  assert.equal(payments().length, 1);
  assert.deepEqual(payments()[0].body.invoices, [{ invoice_id: "Inv42", amount: 46 }]);
  assert.equal(payments()[0].body.type_id, "31");
  assert.equal(payments()[0].body.transaction_reference, "5KqZ9bQ...");
  assert.equal(payments()[0].body.date, "2026-10-06");

  assert.equal((await handleSend21Webhook(req, deps)).body, "already handled");
  const again = await handleSend21Webhook(signed(confirmed(), "dlv_2"), deps);
  assert.equal(JSON.parse(again.body).action, "ignore", "new delivery id, same payment: still only one payment");
  assert.equal(payments().length, 1);
});

test("bad, old or missing signatures get 401 and change nothing", async () => {
  const { fetchImpl, deps } = setup();
  await createLinkForInvoice("Inv42", deps);
  for (const req of [signed(confirmed(), "d", Math.floor(Date.now() / 1000) - 400), signed(confirmed(), "d", undefined, "wrong"), { body: Buffer.from("{}"), headers: {} }]) {
    assert.equal((await handleSend21Webhook(req, deps)).status, 401);
  }
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith("/payments")).length, 0);
});

test("a different amount, another pay link and mismatch events are not recorded", async () => {
  const { fetchImpl, deps } = setup();
  await createLinkForInvoice("Inv42", deps);
  const r1 = await handleSend21Webhook(signed(confirmed({ fiatAmount: 40 }), "a"), deps);
  assert.equal(JSON.parse(r1.body).action, "review");
  const r2 = await handleSend21Webhook(signed(confirmed({ paymentRequestId: "pr_other" }), "b"), deps);
  assert.equal(JSON.parse(r2.body).action, "ignore");
  const r3 = await handleSend21Webhook(signed({ event: "draft.amount_mismatch", data: { orderId: "invoiceninja-Inv42" } }, "c"), deps);
  assert.equal(JSON.parse(r3.body).action, "review");
  const r4 = await handleSend21Webhook(signed({ event: "payment_request.expired", data: { orderId: "invoiceninja-Inv42", opened: true } }, "e"), deps);
  assert.equal(JSON.parse(r4.body).action, "expired");
  assert.equal(fetchImpl.calls.filter((c) => c.url.endsWith("/payments")).length, 0);
});

test("V2 window is 5 minutes", () => {
  const body = Buffer.from("{}");
  const h = signV2(body, "d", 1000, SECRET);
  assert.equal(verifySignatureV2(body, h, "d", SECRET, 1300), true);
  assert.equal(verifySignatureV2(body, h, "d", SECRET, 1301), false);
});
