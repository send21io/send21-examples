// Offline tests: keys are generated per run, nothing touches a relay or send21.
import assert from "node:assert/strict";
import test from "node:test";

import { generateSecretKey, getPublicKey, nip17, nip19, verifyEvent } from "nostr-tools";

import { handleDirectMessage, handleWebhook, menuText, parseCommand, parseMenu, payNote, rateLimiter, secretKeyFrom } from "../src/bot.js";
import { buildPaymentButton, buildPaymentRequest, cleanDeclineNote, parseOptions, signV2, verifySignatureV2 } from "../src/send21.js";

const options = parseOptions('[{"currency":"Btc","network":"Mainnet","address":"you@your-wallet.com","method":"Lightning"},{"currency":"Usdc","network":"Base","address":"0xabc"}]');
const menu = parseMenu('{"coffee":{"amount":5,"currency":"EUR","label":"A coffee"}}');
const secret = "whsec_test_only";

function setup() {
  const botSk = generateSecretKey();
  const payerSk = generateSecretKey();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ id: "pr-1", payPath: "/pay/abc123" }) };
  };
  const deps = { secretKey: botSk, menu, options, config: { send21ApiKey: "s21_test", send21WebhookSecret: secret }, fetchImpl, allow: rateLimiter({ max: 2 }), links: new Map(), deliveries: new Set() };
  const dm = (text) => nip17.wrapEvent(payerSk, { publicKey: getPublicKey(botSk) }, text);
  const read = (wrap) => nip17.unwrapEvent(wrap, payerSk);
  return { botSk, payerSk, calls, deps, dm, read };
}

function webhook(event, data, deliveryId = "dlv-1", now = Math.floor(Date.now() / 1000)) {
  const body = Buffer.from(JSON.stringify({ event, data }));
  return { headers: { "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(body, deliveryId, now, secret) }, body };
}

test("commands and menu", () => {
  assert.deepEqual(parseCommand(" Pay coffee "), { kind: "pay", key: "coffee" });
  assert.deepEqual(parseCommand("help"), { kind: "menu" });
  assert.equal(parseCommand("pay 5000 to 0xevil").kind, "unknown");
  assert.match(menuText(menu), /pay coffee - A coffee: 5 EUR/);
  assert.throws(() => parseMenu('{"Bad Key":{"amount":1,"currency":"EUR"}}'));
  assert.throws(() => parseOptions('[{"currency":"Doge","network":"Mainnet","address":"x"}]'));
});

test("payment request body follows the API", () => {
  const { body, idempotencyKey } = buildPaymentRequest({ orderId: "nostr-e1", item: "A coffee", amount: 5, currency: "EUR" }, options, { declineNote: "<b>No</b> worries", expiryHours: 9999 });
  assert.equal(idempotencyKey, "nostr-e1");
  assert.equal(body.reuseOpenForOrder, true);
  assert.equal(body.expiryHours, 720);
  assert.equal(body.declineNote, "No worries");
  assert.equal(cleanDeclineNote("x".repeat(300)).length, 200);
  assert.deepEqual(buildPaymentButton({ name: "Tip", amount: 3, currency: "EUR" }, options), { name: "Tip", fiatCurrency: "EUR", fiatAmount: 3, options });
});

test("a DM 'pay coffee' gets a fresh pay link back, privately", async () => {
  const { calls, deps, dm, read, payerSk } = setup();
  const wrap = dm("pay coffee");
  const reply = await handleDirectMessage(wrap, deps);
  assert.equal(reply.kind, 1059);
  assert.equal(await handleDirectMessage(wrap, deps), null, "same DM twice is answered once");
  const rumor = read(reply);
  assert.match(rumor.content, /https:\/\/send21\.io\/pay\/abc123/);
  assert.match(rumor.content, /sign and send from your own wallet/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://send21.io/api/v1/payment-requests");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.fiatAmount, 5);
  assert.match(sent.orderId, /^nostr-[0-9a-f]{64}$/);
  assert.equal(calls[0].init.headers["Idempotency-Key"], sent.orderId);
  assert.equal(deps.links.get(sent.orderId).pubkey, getPublicKey(payerSk));
});

test("unknown items get the menu and create nothing; rate limit holds", async () => {
  const { calls, deps, dm, read } = setup();
  assert.match(read(await handleDirectMessage(dm("pay yacht"), deps)).content, /No "yacht"/);
  assert.equal(calls.length, 0);
  // Distinct texts give distinct rumor ids (same text in the same second is one request).
  await handleDirectMessage(dm("pay coffee"), deps);
  await handleDirectMessage(dm("Pay coffee"), deps);
  assert.match(read(await handleDirectMessage(dm("PAY coffee"), deps)).content, /Too many/);
  assert.equal(calls.length, 2);
});

test("a gift wrap for someone else is ignored", async () => {
  const { deps, payerSk } = setup();
  const other = nip17.wrapEvent(payerSk, { publicKey: getPublicKey(generateSecretKey()) }, "pay coffee");
  assert.equal(await handleDirectMessage(other, deps), null);
});

test("webhook signature: valid, tampered, stale, wrong delivery id", () => {
  const now = 1_800_000_000;
  const body = Buffer.from('{"event":"draft.confirmed"}');
  const header = signV2(body, "d1", now, secret);
  assert.equal(verifySignatureV2(body, header, "d1", secret, now + 10), true);
  assert.equal(verifySignatureV2(Buffer.from('{"event":"x"}'), header, "d1", secret, now), false);
  assert.equal(verifySignatureV2(body, header, "d1", secret, now + 301), false);
  assert.equal(verifySignatureV2(body, header, "d2", secret, now), false);
  assert.equal(verifySignatureV2(body, header, "d1", "", now), false);
});

test("draft.confirmed DMs the payer once; repeats are ignored", async () => {
  const { deps, dm, read } = setup();
  await handleDirectMessage(dm("pay coffee"), deps);
  const [orderId] = deps.links.keys();
  const data = { orderId, paymentRequestId: "pr-1", fiatCurrency: "EUR", fiatAmount: 5, sentAmount: "0.00005", sentCurrency: "Btc", network: "Mainnet" };
  const first = handleWebhook(webhook("draft.confirmed", data), deps);
  assert.equal(first.status, 200);
  assert.match(read(first.dm).content, /Payment confirmed: 0.00005 Btc on Mainnet/);
  const again = handleWebhook(webhook("draft.confirmed", data), deps);
  assert.equal(again.dm, null);
});

test("wrong amount, unknown order, other request id, bad signature", async () => {
  const { deps, dm, read } = setup();
  await handleDirectMessage(dm("pay coffee"), deps);
  const [orderId] = deps.links.keys();
  const short = handleWebhook(webhook("draft.confirmed", { orderId, paymentRequestId: "pr-1", fiatCurrency: "EUR", fiatAmount: 4 }, "d2"), deps);
  assert.doesNotMatch(read(short.dm).content, /confirmed/);
  assert.equal(handleWebhook(webhook("draft.confirmed", { orderId: "button:x", fiatCurrency: "EUR", fiatAmount: 5 }, "d3"), deps).dm, null);
  assert.equal(handleWebhook(webhook("draft.confirmed", { orderId, paymentRequestId: "pr-9", fiatCurrency: "EUR", fiatAmount: 5 }, "d4"), deps).dm, null);
  const bad = webhook("draft.confirmed", { orderId }, "d5");
  bad.headers["x-send21-signature-v2"] = "t=1,v1=" + "0".repeat(64);
  assert.equal(handleWebhook(bad, deps).status, 401);
  assert.equal(deps.deliveries.has("d5"), false);
  assert.match(read(handleWebhook(webhook("payment_request.expired", { orderId }, "d6"), deps).dm).content, /expired/);
});

test("public note carries the pay button URL and a valid signature", () => {
  const sk = generateSecretKey();
  const note = payNote(sk, { text: "Tips welcome", url: "https://send21.io/b/tok123" });
  assert.equal(note.kind, 1);
  assert.equal(verifyEvent(note), true);
  assert.deepEqual(note.tags, [["r", "https://send21.io/b/tok123"]]);
  assert.throws(() => payNote(sk, { text: "x", url: "https://evil.example/b/1" }));
});

test("secret key parsing accepts nsec and hex only", () => {
  const sk = generateSecretKey();
  assert.deepEqual(secretKeyFrom(nip19.nsecEncode(sk)), sk);
  assert.deepEqual(secretKeyFrom(Buffer.from(sk).toString("hex")), sk);
  assert.throws(() => secretKeyFrom(""));
});
