import assert from "node:assert/strict";
import { test } from "node:test";
import { key, pair, start, user } from "./helpers.js";

test("pairing: a link adds a mutual contact after one confirm, and shows only name and color", async (t) => {
  const s = await start();
  t.after(() => s.close());
  const a = await user(s, "Alex");
  const b = await user(s, "Sam");

  // The pretty link works without the app: it redirects into the PWA.
  const redirect = await s.call("GET", `/p/${a.code}`);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), `/#/p/${a.code}`);

  const info = await s.call("GET", `/api/pair/${a.code}`);
  assert.deepEqual(Object.keys(info.json).sort(), ["color", "name"]);
  assert.equal(info.json.name, "Alex");

  const add = await s.call("POST", "/api/contacts", { token: b.token, body: { code: a.code } });
  assert.equal(add.status, 200);
  assert.equal(add.json.already, false);

  const meA = await s.call("GET", "/api/me", { token: a.token });
  const meB = await s.call("GET", "/api/me", { token: b.token });
  assert.deepEqual(meA.json.contacts.map((c) => c.name), ["Sam"]);
  assert.deepEqual(meB.json.contacts.map((c) => c.name), ["Alex"]);
  // Contacts list what someone accepts, never their addresses.
  assert.ok(meB.json.contacts[0].accepts.includes("usdc-sol"));
  assert.equal(JSON.stringify(meB.json.contacts).includes("HQCm"), false);

  const again = await s.call("POST", "/api/contacts", { token: b.token, body: { code: a.code } });
  assert.equal(again.json.already, true);
});

test("pairing: own code, unknown code and a reset link are refused", async (t) => {
  const s = await start();
  t.after(() => s.close());
  const a = await user(s, "Alex");
  const b = await user(s, "Sam");
  assert.equal((await s.call("POST", "/api/contacts", { token: a.token, body: { code: a.code } })).status, 400);
  assert.equal((await s.call("POST", "/api/contacts", { token: a.token, body: { code: "nope-nope-nope" } })).status, 404);
  assert.equal((await s.call("POST", "/api/contacts", { body: { code: a.code } })).status, 401);

  await s.call("POST", "/api/me/pair-code", { token: a.token });
  assert.equal((await s.call("POST", "/api/contacts", { token: b.token, body: { code: a.code } })).status, 404);
});

test("only contacts can be asked for money", async (t) => {
  const s = await start();
  t.after(() => s.close());
  const a = await user(s, "Alex");
  const b = await user(s, "Sam");
  const r = await s.call("POST", "/api/requests", { token: a.token, body: { kind: "request", contactIds: [b.id], amount: 10, clientKey: key() } });
  assert.equal(r.status, 403);
  await pair(s, a, b);
  const ok = await s.call("POST", "/api/requests", { token: a.token, body: { kind: "request", contactIds: [b.id], amount: 10, clientKey: key() } });
  assert.equal(ok.status, 201);
});
