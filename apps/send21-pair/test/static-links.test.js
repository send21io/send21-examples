// The Pages build has no server: links carry the data. Every field from another phone is checked.
import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = new EventTarget();
globalThis.location = { href: "https://example.org/pair/" };
const { staticApi, readCard, readRequest } = await import("../web/lib/static-api.js");
const { encodeCard } = await import("../web/lib/core.js");

const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const goodReq = (over = {}) => ({ v: 1, i: "req_123456", k: "request", t: { i: "user_abcdef", n: "Alex", c: "#34D8A6" }, p: { i: "user_xyz123", n: "Sam" },
  f: "SEK", a: 120, m: "Pizza", s: "usdc-sol", d: SOL, u: 11320000, c: Date.now(), e: Date.now() + 3600_000, ...over });
const wait = async (fn) => { for (let i = 0; i < 50 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 60)); };

test("a request link with any tampered field is refused", () => {
  assert.equal(readRequest(encodeCard(goodReq())).fiat_amount, 120);
  for (const over of [{ v: 2 }, { s: "usdt-tron" }, { k: "steal" }, { i: "x" }, { t: { i: "<b>", n: "A" } }, { f: "XYZ" }, { a: -1 }, { a: 12.345 }, { a: "12" }, { a: 1e9 },
    { d: "not-an-address" }, { d: "0x0000000000000000000000000000000000000000" }, { u: 0 }, { u: 1.5 }, { u: "100" }, { t: { i: "user_abcdef", n: "\u200B\u202E" } }])
    assert.throws(() => readRequest(encodeCard(goodReq(over))), /link/i, JSON.stringify(over));
  assert.throws(() => readRequest("%%%"), /link/i);
  assert.throws(() => readRequest(""), /link/i);
});

test("names, notes and colors from a link are cleaned before they reach the screen", () => {
  const r = readRequest(encodeCard(goodReq({ t: { i: "user_abcdef", n: "\u202EAl\u200Bex", c: "red;x" }, m: "Pizza\u2066".repeat(30) })));
  assert.equal(r.receiver_name, "Alex");
  assert.match(r.receiver_color, /^#[0-9A-F]{6}$/i);
  assert.ok([...r.note].length <= 80);
  assert.doesNotMatch(r.note, /\u2066/);
  const card = readCard(encodeCard({ v: 1, i: "user_abcdef", n: "  Sam\u0000 ", c: "#FF5A8A", a: { "usdc-sol": SOL, "btc": "javascript:alert(1)" } }));
  assert.deepEqual(card, { id: "user_abcdef", name: "Sam", color: "#FF5A8A", addresses: { "usdc-sol": SOL } });
  assert.throws(() => readCard(encodeCard({ v: 1, i: "a", n: "Sam" })));
  assert.throws(() => readCard(encodeCard({ v: 1, i: "user_abcdef", n: "\u200B" })));
});

test("static mode: amounts are checked, a double tap simulates once, closed stays closed, a late payment is shown", async () => {
  const api = staticApi("t1");
  await api.signup({ name: "Alex", fiat: "SEK" });
  await assert.rejects(api.createRequests({ kind: "link", amount: "1e3", fiat: "SEK" }), /Numbers only/);
  await assert.rejects(api.createRequests({ kind: "link", amount: "12.345", fiat: "SEK" }), /decimals/);
  const [r] = await api.createRequests({ kind: "link", amount: "45,50", fiat: "SEK", note: "Lemonade" });
  assert.equal(r.fiat_amount, 45.5);
  assert.ok(r.expires_at > Date.now());
  await Promise.all([api.simulate(r.id, "", "ok"), api.simulate(r.id, "", "ok")]);
  await wait(async () => (await api.payInfo(r.id)).status === "paid");
  const paid = await api.payInfo(r.id);
  assert.equal(paid.status, "paid");
  const tx = paid.tx_id;
  assert.equal((await api.simulate(r.id, "", "ok")).ok, false, "a paid request can't be paid again");
  await api.cancel(r.id);
  assert.equal((await api.payInfo(r.id)).status, "paid", "paid is final");
  assert.equal((await api.simulate(r.id, "", "late")).ok, true);
  const v = await api.payInfo(r.id);
  assert.equal(v.status, "paid");
  assert.equal(v.tx_id, tx);
  assert.equal(v.late.state, "paid");
});

test("static mode: expire, then a receipt for the closed request is a payment after close", async () => {
  const api = staticApi("t2");
  await api.signup({ name: "Alex", fiat: "SEK" });
  const [r] = await api.createRequests({ kind: "link", amount: 20, fiat: "SEK" });
  await api.simulate(r.id, "", "expire");
  assert.equal((await api.payInfo(r.id)).status, "expired");
  const out = await api.applyReceipt(encodeCard({ v: 1, i: r.id, x: "mock-abc123", n: "Sam" }));
  assert.equal(out.after_close, true);
  assert.equal(out.status, "expired");
  assert.equal((await api.payInfo(r.id)).late.tx_id, "mock-abc123");
  await assert.rejects(api.applyReceipt(encodeCard({ v: 1, i: r.id, x: "<script>" })), /link/i);
});

test("static mode: the same form key creates the request once", async () => {
  const api = staticApi("t3");
  await api.signup({ name: "Alex", fiat: "SEK" });
  const k = "k_1234567890";
  const [a] = await api.createRequests({ kind: "link", amount: 10, fiat: "SEK", clientKey: k });
  const [b] = await api.createRequests({ kind: "link", amount: 10, fiat: "SEK", clientKey: k });
  assert.equal(a.id, b.id);
  assert.equal((await api.me()).activity?.length ?? 1, 1);
});
