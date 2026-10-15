import assert from "node:assert/strict";
import { createECDH, createDecipheriv, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { encryptPayload } from "../server/webpush.js";
import { key, sleep, start, user } from "./helpers.js";

/** Read SSE messages from a URL until `until` returns true. */
async function sse(url, until, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(url, { signal: ctrl.signal });
  const seen = [];
  let buf = "";
  try {
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (line) { const m = JSON.parse(line.slice(6)); seen.push(m); if (until(m)) { ctrl.abort(); return seen; } }
      }
    }
  } catch (err) { if (err.name !== "AbortError") throw err; } finally { clearTimeout(timer); }
  return seen;
}

test("mock end-to-end: pair, request, notification, pay screen, simulated signed webhook, Paid ✓ for both", async (t) => {
  const s = await start({ simulateDelayMs: 200 });
  t.after(() => s.close());
  const alex = await user(s, "Alex");
  const sam = await user(s, "Sam");

  // Sam listens for notifications like the open app does.
  const samEvents = sse(`${s.base}/api/events?t=${sam.token}`, (m) => m.type === "notify" && /asks for/.test(m.title));
  await sleep(50);
  // Pair: Sam opens Alex's link and confirms.
  assert.equal((await s.call("POST", "/api/contacts", { token: sam.token, body: { code: alex.code } })).status, 200);
  // Alex requests 120 SEK from Sam.
  const created = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "request", contactIds: [sam.id], amount: 120, note: "Pizza", clientKey: key() } });
  assert.equal(created.status, 201, created.text);
  const req = created.json.requests[0];
  assert.equal(req.status_text, "Waiting for Sam to pay");
  const notes = await samEvents;
  const note = notes.find((m) => m.type === "notify" && /asks for/.test(m.title));
  assert.equal(note.title, "Alex asks for 120 SEK");
  assert.match(note.url, new RegExp(`^/#/r/${req.id}\\?k=`));

  // The notification opens the pay screen; it needs no login.
  const k = new URLSearchParams(note.url.split("?")[1]).get("k");
  const view = await s.call("GET", `/api/pay/${req.id}?k=${k}`);
  assert.equal(view.json.status_text, "Alex is waiting for you");
  assert.match(view.json.payment_uri, /^solana:HQCm.*spl-token=4zMMC9/);

  // Both sides watch the status live; "Simulate payment" signs and delivers draft.seen + draft.confirmed.
  const live = sse(`${s.base}/api/pay/${req.id}/events?k=${k}`, (m) => m.status === "paid");
  await sleep(50);
  assert.equal((await s.call("POST", `/api/pay/${req.id}/simulate?k=${k}`)).status, 202);
  const statuses = (await live).map((m) => m.status);
  assert.deepEqual([...new Set(statuses)], ["awaiting", "seen", "paid"]);

  const meA = await s.call("GET", "/api/me", { token: alex.token });
  const meS = await s.call("GET", "/api/me", { token: sam.token });
  assert.equal(meA.json.activity[0].status_text, "Paid ✓");
  assert.equal(meS.json.activity[0].status_text, "Paid ✓");
  // The simulated retry reused the delivery id and was deduped: 2 deliveries stored, not 3.
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n, 2);
});

test("an open link (market stall) can be paid by anyone without the app", async (t) => {
  const s = await start({ simulateDelayMs: 0 });
  t.after(() => s.close());
  const alex = await user(s, "Alex");
  const r = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "link", amount: 45, note: "Honey jar", clientKey: key() } });
  const req = r.json.requests[0];
  const pretty = await s.call("GET", req.pay_path);
  assert.equal(pretty.status, 302);
  assert.match(pretty.headers.get("location"), /^\/#\/r\//);
  const k = req.pay_path.split("k=")[1];
  const v = await s.call("GET", `/api/pay/${req.id}?k=${k}`);
  assert.equal(v.json.payer, null);
  await s.call("POST", `/api/pay/${req.id}/simulate?k=${k}`);
  assert.equal((await s.call("GET", `/api/pay/${req.id}?k=${k}`)).json.status, "paid");
});

test("demo mode polls the public demo draft and marks it paid", async (t) => {
  let status = "AwaitingPayment";
  const fake = async (url, init) => {
    if (init?.method === "POST") return new Response(JSON.stringify({ id: "8befe799-d73d-4b70-b5bf-1d0c8567bfc4", network: "SolanaDevnet", currency: "Usdc", receiverAddress: "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ", amountBaseUnits: 100006, paymentUri: "solana:HQCm?amount=0.100006", status: "AwaitingPayment", expiresAt: "2026-10-15T20:23:27.149Z" }), { status: 201 });
    return new Response(JSON.stringify({ id: "8befe799-d73d-4b70-b5bf-1d0c8567bfc4", amountBaseUnits: 100006, status, paidTxId: status === "Confirmed" ? "sig123" : null }), { status: 200 });
  };
  const s = await start({ mode: "demo", fetch: fake, pollMs: 60_000 });
  t.after(() => s.close());
  const alex = await user(s, "Alex");
  const r = await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "link", amount: 45, clientKey: key() } });
  assert.equal(r.status, 201, r.text);
  status = "Confirmed";
  await s.app.pollDemo();
  const row = s.app.db.prepare("SELECT status, tx_id FROM requests").get();
  assert.deepEqual({ ...row }, { status: "paid", tx_id: "sig123" });
});

// ---- Web Push: VAPID + aes128gcm, checked against a fake push service ------
function decrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
  const shared = uaEcdh.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaEcdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

test("web push: an encrypted, VAPID-signed push reaches the payer's push service", async (t) => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const got = [];
  const push = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { got.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201).end(); });
  });
  await new Promise((r) => push.listen(0, "127.0.0.1", r));
  t.after(() => push.close());
  const endpoint = `http://127.0.0.1:${push.address().port}/push/abc`;

  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const s = await start({ push: true, vapidFile: join(mkdtempSync(join(tmpdir(), "vapid-")), "vapid.json") });
  t.after(() => s.close());
  const alex = await user(s, "Alex");
  const sam = await user(s, "Sam");
  await s.call("POST", "/api/contacts", { token: sam.token, body: { code: alex.code } });
  // The endpoint check wants https; register directly for the test push service.
  s.app.db.prepare("INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, 0)").run(endpoint, sam.id, ua.getPublicKey().toString("base64url"), auth.toString("base64url"));
  await s.call("POST", "/api/requests", { token: alex.token, body: { kind: "request", contactIds: [sam.id], amount: 7, clientKey: key() } });
  for (let i = 0; i < 50 && !got.length; i++) await sleep(20);
  assert.equal(got.length, 1);
  const h = got[0].headers;
  assert.equal(h["content-encoding"], "aes128gcm");
  const payload = JSON.parse(decrypt(got[0].body, ua, auth));
  assert.equal(payload.title, "Alex asks for 7 SEK");

  // The VAPID JWT is signed by the server's key and scoped to the push service origin.
  const [, jwt, k] = h.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  const [hd, cl, sig] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(cl, "base64url")).aud, new URL(endpoint).origin);
  const pub = Buffer.from(k, "base64url");
  const jwk = { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") };
  assert.ok(verify("sha256", Buffer.from(`${hd}.${cl}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("web push encryption round-trips (RFC 8291)", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const body = encryptPayload("hello ✓", { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") });
  assert.equal(decrypt(body, ua, auth), "hello ✓");
});
