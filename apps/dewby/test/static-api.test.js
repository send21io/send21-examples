// The GitHub Pages build runs on the client-side mock (send21-pair's lib/static-api.js). On one
// origin (send21io.github.io) dewby and pair must not see each other's data.
import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = new EventTarget();
globalThis.location = { href: "https://example.org/dewby/" };
const { staticApi } = await import("../../send21-pair/web/lib/static-api.js");

test("brand prefix keeps storage apart and puts the brand in the wallet memo", async () => {
  const dewby = staticApi("default", { storagePrefix: "dewby", memo: "dewby" });
  await dewby.signup({ name: "Alex", fiat: "SEK" });
  assert.ok(store.has("dewby.static.default"));
  assert.ok(!store.has("pair.static.default"));
  const pair = staticApi("default");
  assert.equal(pair.hasUser(), false, "pair on the same origin does not see dewby's user");

  const [r] = await dewby.createRequests({ kind: "link", amount: 45, fiat: "SEK", note: "Lemonade" });
  const view = await dewby.payInfo(r.id);
  assert.match(decodeURIComponent(view.payment_uri), /message=dewby: Lemonade/);
  assert.doesNotMatch(view.payment_uri, /send21/);
  assert.equal(view.status, "awaiting");
  await dewby.simulate(r.id, "", "ok");
  for (let i = 0; i < 40 && (await dewby.payInfo(r.id)).status !== "paid"; i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.equal((await dewby.payInfo(r.id)).status, "paid");
});
