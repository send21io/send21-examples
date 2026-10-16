import assert from "node:assert/strict";
import { test } from "node:test";
import { apiProvider, demoProvider, mockProvider } from "../server/send21.js";
import { createApp, key, pair, start, tmpDb, user } from "./helpers.js";

const ALEX = { "usdc-sol": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", "btc": "tb1qtkf5lt02n082smkkfmfvce4p3p4nc6trhkfrx5" };
const SAM = { "usdc-sol": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "eurc-base": "0x1111111111111111111111111111111111111111" };

function spy(provider) {
  const calls = [];
  return { calls, mode: provider.mode, async createDraft(args) { calls.push(args); return provider.createDraft(args); } };
}

test("a request pays the RECEIVER's own address, fixed server-side", async (t) => {
  const p = spy(mockProvider());
  const s = await start({ provider: p });
  t.after(() => s.close());
  const alex = await user(s, "Alex", { fiat: "SEK", addresses: ALEX });
  const sam = await user(s, "Sam", { fiat: "EUR", addresses: SAM });
  await pair(s, alex, sam);

  // Alex asks Sam: the draft goes to Alex's address. Extra fields from the browser are ignored.
  const r = await s.call("POST", "/api/requests", { token: alex.token, body: {
    kind: "request", contactIds: [sam.id], amount: 120, note: "Pizza", clientKey: key(),
    receiverAddress: "AttackerAddr1111111111111111111111111111111", address: "x", asset: "btc" } });
  assert.equal(r.status, 201, r.text);
  assert.equal(p.calls[0].receiverAddress, ALEX["usdc-sol"]);
  assert.equal(p.calls[0].assetId, "usdc-sol");
  assert.equal(p.calls[0].fiat, "SEK");

  // Sam pays Alex ("send"): still Alex's address, from Alex's profile.
  const sendR = await s.call("POST", "/api/requests", { token: sam.token, body: { kind: "send", contactIds: [alex.id], amount: 20, clientKey: key() } });
  assert.equal(sendR.status, 201, sendR.text);
  assert.equal(p.calls[1].receiverAddress, ALEX["usdc-sol"]);

  // Alex asks in EUR is not possible here (Alex's fiat is SEK), but Sam asking Alex uses Sam's EURC first for EUR.
  await s.call("POST", "/api/requests", { token: sam.token, body: { kind: "request", contactIds: [alex.id], amount: 5, clientKey: key() } });
  assert.equal(p.calls[2].receiverAddress, SAM["usdc-sol"]); // usdc-sol beats eurc-base (Solana before Base)

  // The pay page shows the link with that same address and amount.
  const payPath = r.json.requests[0].pay_path.replace("/r/", "/api/pay/");
  const view = await s.call("GET", payPath);
  assert.equal(view.json.receiver_address, ALEX["usdc-sol"]);
  assert.match(view.json.payment_uri, new RegExp(`^solana:${ALEX["usdc-sol"]}\\?amount=`));
  assert.equal(view.json.testnet, true);
  // Without the secret key in the link the page does not open.
  assert.equal((await s.call("GET", payPath.split("?")[0] + "?k=wrong")).status, 404);
});

test("idempotency: the same clientKey creates one draft; a changed amount is refused", async (t) => {
  const p = spy(mockProvider());
  const s = await start({ provider: p });
  t.after(() => s.close());
  const alex = await user(s, "Alex", { addresses: ALEX });
  const sam = await user(s, "Sam", { addresses: SAM });
  await pair(s, alex, sam);
  const k = key();
  const body = { kind: "request", contactIds: [sam.id], amount: 50, clientKey: k };
  const [one, two] = await Promise.all([
    s.call("POST", "/api/requests", { token: alex.token, body }),
    s.call("POST", "/api/requests", { token: alex.token, body }),
  ]);
  const three = await s.call("POST", "/api/requests", { token: alex.token, body });
  assert.equal(one.json.requests[0].id, two.json.requests[0].id);
  assert.equal(one.json.requests[0].id, three.json.requests[0].id);
  const rows = s.app.db.prepare("SELECT COUNT(*) AS n FROM requests").get().n;
  assert.equal(rows, 1);
  // The key sent to send21 is stable per request, so send21 dedupes too.
  assert.ok(p.calls.every((c) => c.idempotencyKey === `pair-${k}-0`));

  const changed = await s.call("POST", "/api/requests", { token: alex.token, body: { ...body, amount: 51 } });
  assert.equal(changed.status, 422);
});

test("split a bill: N drafts, shares add up, all to the requester", async (t) => {
  const p = spy(mockProvider());
  const s = await start({ provider: p });
  t.after(() => s.close());
  const alex = await user(s, "Alex", { addresses: ALEX });
  const sam = await user(s, "Sam", { addresses: SAM });
  const kim = await user(s, "Kim", { addresses: SAM });
  await pair(s, alex, sam);
  await pair(s, alex, kim);
  const r = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "request", contactIds: [sam.id, kim.id], amount: 100, note: "Dinner", includeMe: true, clientKey: key() } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.json.requests.map((x) => x.fiat_amount), [33.34, 33.33]);
  assert.equal(new Set(r.json.requests.map((x) => x.split_id)).size, 1);
  assert.ok(p.calls.every((c) => c.receiverAddress === ALEX["usdc-sol"]));
  const kimMe = await s.call("GET", "/api/me", { token: kim.token });
  assert.equal(kimMe.json.activity[0].status_text, "Alex is waiting for you");
});

test("a receiver without a wallet address gets a plain error, nothing is created", async (t) => {
  const s = await start({ mode: "api", allowLive: true, webhookSecret: "x", provider: spy(mockProvider()) });
  t.after(() => s.close());
  const alex = await user(s, "Alex", { addresses: {} });
  const sam = await user(s, "Sam", { addresses: {} });
  await pair(s, alex, sam);
  const r = await s.call("POST", "/api/requests", { token: sam.token, body: { kind: "send", contactIds: [alex.id], amount: 5, clientKey: key() } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /hasn't added a wallet address/);
});

test("api mode: POST /api/v1/drafts with the scoped key, Idempotency-Key and the receiver's address", async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    const b = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c", receiverAddress: b.receiverAddress, network: b.network, currency: b.currency,
      amountBaseUnits: 11420000, amountSats: 11420000, paymentUri: `solana:${b.receiverAddress}?amount=11.42&spl-token=EPjF`, status: "AwaitingPayment", expiresAt: "2026-10-18T10:00:00.000Z" }), { status: 201 });
  };
  const p = apiProvider({ key: "s21_test", fetch: fakeFetch });
  const d = await p.createDraft({ assetId: "usdc-sol", receiverAddress: ALEX["usdc-sol"], fiat: "SEK", fiatAmount: 120, memo: "send21 pair 1234", idempotencyKey: "pair-abc-0" });
  assert.equal(seen[0].url, "https://send21.io/api/v1/drafts");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers.Authorization, "Bearer s21_test");
  assert.equal(seen[0].init.headers["Idempotency-Key"], "pair-abc-0");
  assert.deepEqual(seen[0].body, { receiverAddress: ALEX["usdc-sol"], network: "Solana", currency: "Usdc", paymentMethod: "MultiOutput", singleOutput: true,
    fiatCurrency: "SEK", fiatAmount: 120, memo: "send21 pair 1234", expiryHours: 72 });
  assert.equal(d.amountBaseUnits, 11420000);

  // A draft that comes back with another receiver address is never shown.
  const evil = apiProvider({ key: "k", fetch: async () => new Response(JSON.stringify({ id: "x", receiverAddress: "Other111", expiresAt: "2026-10-18T10:00:00.000Z" }), { status: 201 }) });
  await assert.rejects(evil.createDraft({ assetId: "usdc-sol", receiverAddress: ALEX["usdc-sol"], fiat: "SEK", fiatAmount: 1 }), /different receiver address/);

  // send21's own errors come through as messages.
  const testnet = apiProvider({ key: "k", fetch: async () => new Response(JSON.stringify({ error: "Payments on Solana Devnet are not offered on this server." }), { status: 400 }) });
  await assert.rejects(testnet.createDraft({ assetId: "usdc-sol", receiverAddress: ALEX["usdc-sol"], fiat: "SEK", fiatAmount: 1 }), /not offered/);
});

test("api mode: an open pay link uses orderId, reuseOpenForOrder and only the receiver's addresses", async () => {
  let sent;
  const p = apiProvider({ key: "k", fetch: async (url, init) => {
    sent = { url, body: JSON.parse(init.body), idem: init.headers["Idempotency-Key"] };
    return new Response(JSON.stringify({ id: "8d1e4b7a-0c2f-4e6d-b3a9-7f5c1e2d4a6b", payPath: "/pay/abc", options: sent.body.options, expiresAt: "2026-10-18T10:00:00.000Z" }), { status: 201 });
  } });
  const out = await p.createPayLink({ options: [{ assetId: "usdc-sol", address: ALEX["usdc-sol"] }, { assetId: "btc-ln", address: "alex@wallet.example" }], fiat: "SEK", fiatAmount: 45, memo: "Honey", orderId: "req-1", idempotencyKey: "pair-k-0" });
  assert.equal(sent.url, "https://send21.io/api/v1/payment-requests");
  assert.equal(sent.idem, "pair-k-0");
  assert.equal(sent.body.orderId, "req-1");
  assert.equal(sent.body.reuseOpenForOrder, true);
  assert.deepEqual(sent.body.options, [{ currency: "Usdc", network: "Solana", address: ALEX["usdc-sol"] }, { currency: "Btc", network: "Mainnet", address: "alex@wallet.example", method: "Lightning" }]);
  assert.equal(out.payUrl, "https://send21.io/pay/abc");
});

test("demo mode sends only network and currency (the documented CreateDemoDraftRequest)", async () => {
  let body;
  const p = demoProvider({ fetch: async (url, init) => {
    body = JSON.parse(init.body);
    assert.equal(url, "https://send21.io/api/v1/demo/drafts");
    return new Response(JSON.stringify({ id: "8befe799-d73d-4b70-b5bf-1d0c8567bfc4", network: "SolanaDevnet", currency: "Usdc", receiverAddress: "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ",
      amountBaseUnits: 100006, paymentUri: "solana:HQCm?amount=0.100006", status: "AwaitingPayment", expiresAt: "2026-10-15T20:23:27.149Z" }), { status: 201 });
  } });
  const d = await p.createDraft({ assetId: "usdc-sol", receiverAddress: "ignored", fiat: "SEK", fiatAmount: 120 });
  assert.deepEqual(body, { network: "SolanaDevnet", currency: "Usdc" });
  assert.equal(d.amountBaseUnits, 100006);
});

test("api mode refuses to start without PAIR_ALLOW_LIVE (send21 accounts are live-only)", () => {
  assert.throws(() => createApp({ mode: "api", dbFile: tmpDb(), push: false, apiKey: "k", webhookSecret: "s" }), /LIVE networks/);
});
