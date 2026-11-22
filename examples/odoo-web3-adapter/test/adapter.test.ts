import assert from "node:assert/strict";
import { test } from "node:test";

import { createBillDraft, createInvoicePayLink, enrichPending, handleWebhook, txHashFromImportId } from "../src/adapter.ts";
import type { Odoo } from "../src/odoo.ts";
import { buildBillDraft, buildInvoicePaymentRequest, parseOptions, signV2, verifySignatureV2 } from "../src/send21.ts";
import { memoryStore } from "../src/store.ts";

const SECRET = "whsec_test_only_not_a_real_secret";
const WALLET = "0x1111111111111111111111111111111111111111";
const TX = "0x" + "ab".repeat(32);
const options = parseOptions(`[{"currency":"Eurc","network":"Base","address":"${WALLET}"}]`);
const config = { send21ApiKey: "s21_test_only", send21WebhookSecret: SECRET, options, journalId: 5 };

/** Fake Odoo: two moves and statement lines as odoo-web3 would have synced them. */
function fakeOdoo(lines: any[] = []) {
  const calls: any[] = [];
  const moves: Record<number, any> = {
    42: { id: 42, name: "INV/2026/00042", move_type: "out_invoice", state: "posted", amount_residual: 46, currency_id: [1, "EUR"], partner_id: [9, "Acme"], payment_state: "not_paid" },
    77: { id: 77, name: "BILL/2026/0077", move_type: "in_invoice", state: "posted", amount_residual: 120, currency_id: [1, "EUR"], partner_id: [12, "Vendor"], payment_state: "not_paid" },
  };
  const odoo: Odoo = {
    async executeKw(model, method, args, kwargs) {
      calls.push({ model, method, args, kwargs });
      if (model === "account.move" && method === "read") return [moves[(args[0] as number[])[0]]].filter(Boolean);
      if (model === "account.bank.statement.line" && method === "search_read") {
        const hash = ((args[0] as any[]).find((d) => d[0] === "unique_import_id") ?? [])[2];
        return lines.filter((l) => l.unique_import_id.includes(hash));
      }
      return true;
    },
  };
  return { odoo, calls, writes: () => calls.filter((c) => c.method === "write") };
}

function fakeFetch() {
  const calls: any[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const body = url.endsWith("/payment-requests") ? { id: "pr_1", payPath: "/pay/abc" } : { id: "drf_1", paymentUri: "ethereum:..." };
    return { ok: true, status: 201, json: async () => body };
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

const signed = (payload: unknown, deliveryId: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => {
  const body = Buffer.from(JSON.stringify(payload));
  return { body, headers: { "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(body, deliveryId, t, secret) } };
};
const confirmed = (over: Record<string, unknown> = {}) => ({
  event: "draft.confirmed",
  data: { draftId: "drf_9", paymentRequestId: "pr_1", orderId: "odoo-web3-move-42", txId: TX, fiatCurrency: "EUR", fiatAmount: 46, sentAmount: "46.000000", sentCurrency: "EURC", network: "Base", conversionRate: 1, quoteId: "q1", ...over },
});

test("import ids in all odoo-web3 formats give the tx hash", () => {
  assert.equal(txHashFromImportId(`base:${WALLET}:${TX}:3`), TX);
  assert.equal(txHashFromImportId(`gnosis:${TX}:0`), TX);
  assert.equal(txHashFromImportId(TX.toUpperCase().replace("0X", "0x")), TX);
  assert.equal(txHashFromImportId("nope"), null);
});

test("only EVM ERC-20 options are accepted (odoo-web3 syncs ERC-20 transfers)", () => {
  assert.throws(() => parseOptions('[{"currency":"Btc","network":"Mainnet","address":"bc1q"}]'));
  assert.throws(() => parseOptions('[{"currency":"Usdc","network":"Solana","address":"So1"}]'));
});

test("request bodies", () => {
  const pr = buildInvoicePaymentRequest({ id: 42, name: "INV/2026/00042", amount_residual: 46, currency: "eur" }, options);
  assert.equal(pr.idempotencyKey, "odoo-web3-move-42-46.00");
  assert.equal(pr.body.reuseOpenForOrder, true);
  assert.equal(pr.body.declineNote.length <= 200, true);
  const d = buildBillDraft({ id: 77, name: "BILL/2026/0077", amount_residual: 120, currency: "EUR" }, { address: WALLET, network: "Base", currency: "Usdc" });
  assert.deepEqual(d.body, { receiverAddress: WALLET, network: "Base", currency: "Usdc", paymentMethod: "MultiOutput", singleOutput: true, fiatCurrency: "EUR", fiatAmount: 120, memo: "BILL/2026/0077" });
  assert.throws(() => buildBillDraft({ id: 1, name: "x", amount_residual: 0, currency: "EUR" }, { address: WALLET, network: "Base", currency: "Usdc" }));
});

test("signature V2 window", () => {
  const b = Buffer.from("{}");
  const h = signV2(b, "d", 100, SECRET);
  assert.equal(verifySignatureV2(b, h, "d", SECRET, 400), true);
  assert.equal(verifySignatureV2(b, h, "d", SECRET, 401), false);
  assert.equal(verifySignatureV2(b, h, "e", SECRET, 100), false);
});

test("pay link for an invoice is posted to its chatter", async () => {
  const { odoo, calls } = fakeOdoo();
  const fetchImpl = fakeFetch();
  const link = await createInvoicePayLink(42, { odoo, store: memoryStore(), config, fetchImpl });
  assert.equal(link, "https://send21.io/pay/abc");
  assert.equal(fetchImpl.calls[0].headers["Idempotency-Key"], "odoo-web3-move-42-46.00");
  assert.match(calls.find((c) => c.method === "message_post").kwargs.body, /own wallet/);
});

test("confirmation enriches the synced statement line like the Monerium step", async () => {
  const { odoo, writes } = fakeOdoo([{ id: 501, unique_import_id: `base:${WALLET}:${TX}:0`, partner_id: false, amount: 46 }]);
  const store = memoryStore();
  await createInvoicePayLink(42, { odoo, store, config, fetchImpl: fakeFetch() });
  const out = await handleWebhook(signed(confirmed(), "dlv_1"), { odoo, store, config });
  assert.equal(JSON.parse(out.body).result, "enriched");
  const [w] = writes();
  assert.deepEqual(w.args[0], [501]);
  assert.equal(w.args[1].partner_id, 9);
  assert.equal(w.args[1].payment_ref, "INV/2026/00042");
  assert.equal(JSON.parse(w.args[1].transaction_details).source, "send21");

  assert.equal((await handleWebhook(signed(confirmed(), "dlv_1"), { odoo, store, config })).body, "already handled");
  assert.equal(writes().length, 1);
});

test("not synced yet: kept pending, applied by enrich-pending", async () => {
  const lines: any[] = [];
  const { odoo, writes } = fakeOdoo(lines);
  const store = memoryStore();
  await createInvoicePayLink(42, { odoo, store, config, fetchImpl: fakeFetch() });
  assert.equal(JSON.parse((await handleWebhook(signed(confirmed(), "dlv_2"), { odoo, store, config })).body).result, "pending");
  lines.push({ id: 502, unique_import_id: `base:${WALLET}:${TX}:1`, partner_id: false });
  assert.deepEqual(await enrichPending({ odoo, store, config }), { [TX]: "enriched" });
  assert.equal(writes().length, 1);
  assert.deepEqual(store.read().pending, {});
});

test("a line that already has a partner is left alone; other amounts go to review", async () => {
  const { odoo, writes } = fakeOdoo([{ id: 503, unique_import_id: `base:${WALLET}:${TX}:0`, partner_id: [3, "Someone"] }]);
  const store = memoryStore();
  await createInvoicePayLink(42, { odoo, store, config, fetchImpl: fakeFetch() });
  assert.equal(JSON.parse((await handleWebhook(signed(confirmed(), "a"), { odoo, store, config })).body).result, "skipped");
  assert.match(JSON.parse((await handleWebhook(signed(confirmed({ fiatAmount: 40 }), "b"), { odoo, store, config })).body).result, /^review/);
  assert.match(JSON.parse((await handleWebhook(signed(confirmed({ paymentRequestId: "pr_other" }), "c"), { odoo, store, config })).body).result, /^review/);
  assert.equal(writes().length, 0);
});

test("vendor bill: draft prepared (no key on the server), confirmation enriches the outgoing line", async () => {
  const { odoo, writes } = fakeOdoo([{ id: 600, unique_import_id: `base:${WALLET}:${TX}:2`, partner_id: false, amount: -120 }]);
  const store = memoryStore();
  const fetchImpl = fakeFetch();
  const r = await createBillDraft(77, { address: WALLET, network: "Base", currency: "Usdc" }, { odoo, store, config, fetchImpl });
  assert.equal(r.draftId, "drf_1");
  assert.equal(fetchImpl.calls[0].url, "https://send21.io/api/v1/drafts");
  const out = await handleWebhook(signed({ event: "draft.confirmed", data: { draftId: "drf_1", txId: TX, fiatAmount: 120, fiatCurrency: "EUR" } }, "bill_1"), { odoo, store, config });
  assert.equal(JSON.parse(out.body).result, "enriched");
  assert.equal(writes()[0].args[1].payment_ref, "BILL/2026/0077");
});

test("bad signatures change nothing", async () => {
  const { odoo, calls } = fakeOdoo();
  const store = memoryStore();
  for (const req of [signed(confirmed(), "x", Math.floor(Date.now() / 1000) - 600), signed(confirmed(), "x", undefined, "wrong")]) {
    assert.equal((await handleWebhook(req, { odoo, store, config })).status, 401);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(store.read().deliveries, []);
});
