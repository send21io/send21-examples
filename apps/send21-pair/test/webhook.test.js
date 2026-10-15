import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sign, signV2 } from "../server/verify.js";
import { key, pair, start, tmpDb, user } from "./helpers.js";

const SECRET = "whsec_test_secret";

function delivery(event, data, { secret = SECRET, id = randomUUID(), t = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify({ event, data });
  return { raw, id, headers: { "Content-Type": "application/json", "X-Send21-Event": event, "X-Send21-Delivery": id, "X-Send21-Timestamp": String(t), "X-Send21-Signature-V2": signV2(raw, id, t, secret) } };
}
const post = (s, d) => s.call("POST", "/webhooks/send21", { body: d.raw, headers: d.headers });

async function setup(t, extra = {}) {
  const s = await start({ webhookSecret: SECRET, ...extra });
  t.after(() => s.close());
  const alex = await user(s, "Alex", { addresses: { "usdc-sol": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" } });
  const sam = await user(s, "Sam");
  await pair(s, alex, sam);
  const r = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "request", contactIds: [sam.id], amount: 120, clientKey: key() } });
  const row = s.app.db.prepare("SELECT * FROM requests WHERE id = ?").get(r.json.requests[0].id);
  const confirmed = (over = {}) => ({ draftId: row.draft_id, status: "Confirmed", txId: "5KqZ9bQ", confirmations: 1, sentCurrency: "USDC", network: "SolanaDevnet",
    amountSats: row.amount_base_units, sentAmount: "11.32", fiatCurrency: "SEK", fiatAmount: 120, occurredAt: "2026-10-15T20:00:00.000Z", ...over });
  const status = () => s.app.db.prepare("SELECT status, tx_id, review_note FROM requests WHERE id = ?").get(row.id);
  return { s, alex, sam, row, confirmed, status };
}

test("X-Send21-Signature-V2: valid applies, wrong secret / old / missing / legacy-only are 401", async (t) => {
  const { s, confirmed, status } = await setup(t);
  assert.equal((await post(s, delivery("draft.confirmed", confirmed(), { secret: "wrong" }))).status, 401);
  assert.equal((await post(s, delivery("draft.confirmed", confirmed(), { t: Math.floor(Date.now() / 1000) - 301 }))).status, 401);
  const noSig = delivery("draft.confirmed", confirmed());
  delete noSig.headers["X-Send21-Signature-V2"];
  assert.equal((await post(s, noSig)).status, 401);
  // The body-only legacy header is not accepted on its own: it can be replayed.
  noSig.headers["X-Send21-Signature"] = sign(noSig.raw, SECRET);
  assert.equal((await post(s, noSig)).status, 401);
  // A tampered body with the original signature.
  const d = delivery("draft.confirmed", confirmed());
  assert.equal((await post(s, { ...d, raw: d.raw.replace("5KqZ9bQ", "XXXXXXX") })).status, 401);
  assert.equal(status().status, "awaiting");

  const ok = await post(s, delivery("draft.confirmed", confirmed()));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, "paid");
  assert.equal(status().status, "paid");
  assert.equal(status().tx_id, "5KqZ9bQ");
});

test("dedupe on X-Send21-Delivery survives a restart (SQLite, one transaction)", async (t) => {
  const dbFile = tmpDb();
  const s = await start({ dbFile, webhookSecret: SECRET });
  const alex = await user(s, "Alex");
  const sam = await user(s, "Sam");
  await pair(s, alex, sam);
  const r = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "request", contactIds: [sam.id], amount: 9, clientKey: key() } });
  const row = s.app.db.prepare("SELECT * FROM requests WHERE id = ?").get(r.json.requests[0].id);
  const d = delivery("draft.confirmed", { draftId: row.draft_id, sentCurrency: "USDC", network: row.network, amountSats: row.amount_base_units, txId: "tx1" });
  assert.equal((await post(s, d)).json.outcome, "paid");
  assert.equal((await post(s, d)).json.outcome, "duplicate");
  await s.close();

  // "Restart": a new process opens the same file. The retry is still a duplicate.
  const s2 = await start({ dbFile, webhookSecret: SECRET });
  t.after(() => s2.close());
  assert.equal((await post(s2, d)).json.outcome, "duplicate");
  assert.equal(s2.app.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n, 1);
  assert.equal(s2.app.db.prepare("SELECT status FROM requests WHERE id = ?").get(row.id).status, "paid");
});

test("amount, asset or network that don't match the stored request never mark it paid", async (t) => {
  const { s, confirmed, status } = await setup(t);
  const wrongAmount = await post(s, delivery("draft.confirmed", confirmed({ amountSats: confirmed().amountSats + 1 })));
  assert.equal(wrongAmount.json.outcome, "mismatch");
  assert.equal(status().status, "review");
  assert.match(status().review_note, /billed/);
});

test("a different currency or network is a mismatch too", async (t) => {
  const { s, confirmed, status } = await setup(t);
  assert.equal((await post(s, delivery("draft.confirmed", confirmed({ sentCurrency: "EURC" })))).json.outcome, "mismatch");
  assert.equal(status().status, "review");
  const t2 = await setup(t);
  assert.equal((await post(t2.s, delivery("draft.confirmed", t2.confirmed({ network: "Solana" })))).json.outcome, "mismatch");
});

test("draft.amount_mismatch goes to review; an accepted different amount is paid with a note", async (t) => {
  const { s, confirmed, status } = await setup(t);
  await post(s, delivery("draft.amount_mismatch", { draftId: confirmed().draftId, receivedAmountSats: 11000000, receivedAmount: "11.00", amountSats: confirmed().amountSats, sentAmount: "11.32" }));
  assert.equal(status().status, "review");
  const out = await post(s, delivery("draft.confirmed", confirmed({ receivedAmountSats: 11000000, receivedAmount: "11.00" })));
  assert.equal(out.json.outcome, "paid");
  assert.match(status().review_note, /received 11.00|different amount accepted/);
});

test("events never move a request backwards; unknown drafts are recorded and ignored", async (t) => {
  const { s, confirmed, status } = await setup(t);
  assert.equal((await post(s, delivery("draft.seen", { ...confirmed(), status: "Seen" }))).json.outcome, "seen");
  assert.equal((await post(s, delivery("draft.confirmed", confirmed()))).json.outcome, "paid");
  assert.equal((await post(s, delivery("draft.seen", { ...confirmed(), status: "Seen" }))).json.outcome, "no_change");
  assert.equal((await post(s, delivery("draft.expired", { draftId: confirmed().draftId }))).json.outcome, "no_change");
  assert.equal(status().status, "paid");
  assert.equal((await post(s, delivery("draft.confirmed", { draftId: randomUUID() }))).json.outcome, "unknown_draft");
  assert.equal((await post(s, delivery("test", {}))).json.outcome, "unknown_draft");
});
