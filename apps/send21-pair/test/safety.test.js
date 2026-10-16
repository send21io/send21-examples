// Safety rules on the server: payments after close, strict input, rate limits, simulated outcomes,
// expiry and schema upgrades. Runs for dewby too (apps/dewby/test/shared-suite.test.js).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { signV2 } from "../server/verify.js";
import { createApp, key, pair, sleep, start, tmpDb, user } from "./helpers.js";

const SECRET = "whsec_test_secret";
const SOL = { "usdc-sol": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" };

function delivery(event, data, { id = randomUUID(), t = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify({ event, data });
  return { raw, headers: { "Content-Type": "application/json", "X-Send21-Event": event, "X-Send21-Delivery": id, "X-Send21-Timestamp": String(t), "X-Send21-Signature-V2": signV2(raw, id, t, SECRET) } };
}
const post = (s, d) => s.call("POST", "/webhooks/send21", { body: d.raw, headers: d.headers });

async function setup(t, extra = {}) {
  const s = await start({ webhookSecret: SECRET, ...extra });
  t.after(() => s.close());
  const alex = await user(s, "Alex", { addresses: SOL });
  const sam = await user(s, "Sam");
  await pair(s, alex, sam);
  const r = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "request", contactIds: [sam.id], amount: 120, clientKey: key() } });
  const row = () => s.app.db.prepare("SELECT * FROM requests WHERE id = ?").get(r.json.requests[0].id);
  const confirmed = (over = {}) => ({ draftId: row().draft_id, status: "Confirmed", txId: "5KqZ9bQ", confirmations: 1, sentCurrency: "USDC", network: "SolanaDevnet",
    amountSats: row().amount_base_units, sentAmount: "11.32", fiatCurrency: "SEK", fiatAmount: 120, occurredAt: "2026-10-15T20:00:00.000Z", ...over });
  const view = async () => (await s.call("GET", `/api/pay/${row().id}?k=${row().pay_key}`)).json;
  return { s, alex, sam, row, confirmed, view };
}

test("payment after cancel: the request stays cancelled, the txId is recorded and shown, once", async (t) => {
  const { s, alex, row, confirmed, view } = await setup(t);
  assert.equal((await s.call("POST", `/api/requests/${row().id}/cancel`, { token: alex.token })).status, 200);
  const out = await post(s, delivery("draft.confirmed", confirmed({ txId: "LATE1" })));
  assert.equal(out.json.outcome, "after_close");
  assert.equal(row().status, "cancelled", "closed states are final");
  const v = await view();
  assert.equal(v.status, "cancelled");
  assert.equal(v.late.tx_id, "LATE1");
  assert.equal(v.late.state, "cancelled");
  // The same transaction again (a new delivery id) changes nothing.
  assert.equal((await post(s, delivery("draft.confirmed", confirmed({ txId: "LATE1" })))).json.outcome, "no_change");
  assert.ok(s.app.pushLog === undefined || Array.isArray(s.app.pushLog));
});

test("payment after paid with another txId is flagged; the original payment stays", async (t) => {
  const { s, row, confirmed, view } = await setup(t);
  assert.equal((await post(s, delivery("draft.confirmed", confirmed()))).json.outcome, "paid");
  assert.equal((await post(s, delivery("draft.confirmed", confirmed({ txId: "SECOND" })))).json.outcome, "after_close");
  assert.equal(row().status, "paid");
  assert.equal(row().tx_id, "5KqZ9bQ");
  assert.equal((await view()).late.tx_id, "SECOND");
});

test("expired with money on the way records the payment after close", async (t) => {
  const { s, row, confirmed, view } = await setup(t);
  const out = await post(s, delivery("draft.expired", { draftId: confirmed().draftId, receivedAmountSats: 10, receivedAmount: "0.00001", txId: "EXP1" }));
  assert.equal(out.json.outcome, "expired_with_payment");
  assert.equal(row().status, "expired");
  assert.equal((await view()).late.state, "expired");
  // And nothing can reopen it.
  assert.equal((await post(s, delivery("draft.confirmed", confirmed({ txId: "EXP1" })))).json.outcome, "no_change");
  assert.equal(row().status, "expired");
});

test("a delivery without an amount never marks a request paid", async (t) => {
  const { s, row, confirmed } = await setup(t);
  const d = confirmed();
  delete d.amountSats;
  assert.equal((await post(s, delivery("draft.confirmed", d))).json.outcome, "mismatch");
  assert.equal(row().status, "review");
  assert.match(row().review_note, /no amount/);
});

test("names and notes lose invisible and direction-changing characters on the server", async (t) => {
  const s = await start();
  t.after(() => s.close());
  const r = await s.call("POST", "/api/users", { body: { name: "  \u202Eyaps\u200B\u0000  Bo\tB  ", fiat: "SEK" } });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.name, "yaps Bo B");
  const bad = await s.call("POST", "/api/users", { body: { name: "\u200B\u202E\u2066", fiat: "SEK" } });
  assert.equal(bad.status, 400, "a name that is only invisible characters is refused");
  const long = await s.call("POST", "/api/users", { body: { name: "x".repeat(500), fiat: "SEK" } });
  assert.equal(long.status, 400, "over 40 characters is refused, not silently cut");
  const ok40 = await s.call("POST", "/api/users", { body: { name: "\u{1F600}".repeat(40), fiat: "SEK" } });
  assert.equal(ok40.status, 201, "40 emoji count as 40 characters");
});

test("amounts: exponents, too many decimals, zero, negative and over-max are refused server-side", async (t) => {
  const { s, alex, sam } = await setup(t);
  for (const amount of ["1e3", 12.345, 0, -5, 10001, "0x10", "12,3,4", "", null, "Infinity", "NaN", true, [], {}]) {
    const r = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "request", contactIds: [sam.id], amount, clientKey: key() } });
    assert.equal(r.status, 400, `amount ${JSON.stringify(amount)} should be refused, got ${r.status}`);
  }
  const ok = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "request", contactIds: [sam.id], amount: "12,50", note: "a".repeat(300), clientKey: key() } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.requests[0].fiat_amount, 12.5);
  assert.ok([...ok.json.requests[0].note].length <= 80);
});

test("rate limit: too many sign-ups get 429 with Retry-After; turning it off works", async (t) => {
  const s = await start({ rateLimit: { signup: { rate: 1, burst: 2 } } });
  t.after(() => s.close());
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await s.call("POST", "/api/users", { body: { name: `U${i}`, fiat: "SEK" } })));
  assert.deepEqual(codes.map((r) => r.status), [201, 201, 429, 429]);
  assert.ok(Number(codes[2].headers.get("retry-after")) >= 1);
  assert.match(codes[2].json.error, /many/i);
  const off = await start({ rateLimit: false });
  t.after(() => off.close());
  for (let i = 0; i < 15; i++) assert.equal((await off.call("POST", "/api/users", { body: { name: `U${i}`, fiat: "SEK" } })).status, 201);
});

test("simulate: unknown outcome 400, late needs a closed request, expire closes it, double tap once", async (t) => {
  const { s, row } = await setup(t, { simulateDelayMs: 50 });
  const sim = (o) => s.call("POST", `/api/pay/${row().id}/simulate?k=${row().pay_key}&outcome=${o}`);
  assert.equal((await sim("steal")).status, 400);
  assert.equal((await sim("late")).status, 409);
  const [a, b] = await Promise.all([sim("ok"), sim("ok")]);
  assert.deepEqual([a.status, b.status], [202, 202]);
  for (let i = 0; i < 40 && row().status !== "paid"; i++) await sleep(25);
  assert.equal(row().status, "paid");
  const deliveries = s.app.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n;
  assert.ok(deliveries <= 2, `one seen and one confirmed delivery, got ${deliveries}`);
  assert.equal((await sim("late")).json.outcome, "after_close");
  assert.equal(row().status, "paid");
  assert.ok(row().late_tx_id);

  const t2 = await setup(t);
  assert.equal((await t2.s.call("POST", `/api/pay/${t2.row().id}/simulate?k=${t2.row().pay_key}&outcome=expire`)).status, 202);
  assert.equal(t2.row().status, "expired");
  assert.equal((await t2.s.call("POST", `/api/pay/${t2.row().id}/simulate?k=wrong&outcome=ok`)).status, 404);
});

test("mock expiry sweep closes past-due requests through a signed draft.expired", async (t) => {
  const { s, row } = await setup(t);
  assert.ok(row().expires_at > Date.now() + 71 * 3600_000, "72 h to pay");
  s.app.db.prepare("UPDATE requests SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, row().id);
  s.app.sweepMock();
  assert.equal(row().status, "expired");
});

test("an older database gets the payment-after-close columns on start", async () => {
  const file = tmpDb();
  createApp({ mode: "mock", dbFile: file, push: false, log: () => {} }).close();
  const raw = new DatabaseSync(file);
  for (const c of ["late_tx_id", "late_state", "late_event", "late_amount", "late_at"]) raw.exec(`ALTER TABLE requests DROP COLUMN ${c}`);
  raw.close();
  const app = createApp({ mode: "mock", dbFile: file, push: false, log: () => {} });
  const cols = app.db.prepare("PRAGMA table_info(requests)").all().map((c) => c.name);
  app.close();
  for (const c of ["late_tx_id", "late_state", "late_at"]) assert.ok(cols.includes(c), c);
});
