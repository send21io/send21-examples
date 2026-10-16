import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp as createPairApp } from "../../send21-pair/server/app.js";
import { loadBrand } from "../server/brand.js";
import { key, start } from "./helpers.js";

const web = new URL("../web/", import.meta.url);
const B = loadBrand();

test("serves dewby's own UI, with config.js switched to the server backend", async (t) => {
  const s = await start();
  t.after(() => s.close());
  const index = await s.call("GET", "/");
  assert.equal(index.status, 200);
  assert.match(index.text, /<script src="brand\.js"><\/script>/);
  assert.doesNotMatch(index.text.split(loadBrand().siteUrl).join(""), /send21/i); // the share-card URLs are where it is hosted
  assert.match(index.headers.get("content-security-policy"), /script-src 'self'/);
  const cfg = await s.call("GET", "/config.js");
  assert.equal(cfg.text.trim(), 'window.APP_BOOT = { backend: "server", mode: "mock" };');
  const icon = await s.call("GET", "/icons/icon-192.png");
  assert.deepEqual(icon.buf, readFileSync(new URL("icons/icon-192.png", web)));
  const font = await s.call("GET", "/fonts/nunito-latin.woff2");
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
});

test("shared browser code (lib/, vendor/) comes from send21-pair, nothing else does", async (t) => {
  const s = await start();
  t.after(() => s.close());
  const core = await s.call("GET", "/lib/core.js");
  assert.equal(core.text, readFileSync(new URL("../../send21-pair/web/lib/core.js", import.meta.url), "utf8"));
  assert.equal((await s.call("GET", "/vendor/qrcode.js")).status, 200);
  assert.equal((await s.call("GET", "/DESIGN.md")).status, 404);
  assert.equal((await s.call("GET", "/../package.json")).status, 404);

  // The `only` filter on a fallback root: a file there outside lib/ is never served.
  const own = mkdtempSync(join(tmpdir(), "own-")), shared = mkdtempSync(join(tmpdir(), "shared-"));
  writeFileSync(join(own, "index.html"), "own");
  mkdirSync(join(shared, "lib"));
  writeFileSync(join(shared, "lib", "x.js"), "shared lib");
  writeFileSync(join(shared, "secret.txt"), "no");
  const p = await start({ webDirs: [own, { dir: shared, only: ["lib/"] }] }, createPairApp);
  t.after(() => p.close());
  assert.equal((await p.call("GET", "/")).text, "own");
  assert.equal((await p.call("GET", "/lib/x.js")).text, "shared lib");
  assert.equal((await p.call("GET", "/secret.txt")).status, 404);
});

test("the wallet memo carries the brand name, not send21 pair", async (t) => {
  const s = await start();
  t.after(() => s.close());
  const u = await s.call("POST", "/api/users", { body: { name: "Alex", fiat: "SEK" } });
  const r = await s.call("POST", "/api/requests", { token: u.json.token, body: { kind: "link", amount: 45, note: "Lemonade", clientKey: key() } });
  assert.equal(r.status, 201, r.text);
  const row = s.app.db.prepare("SELECT payment_uri FROM requests WHERE id = ?").get(r.json.requests[0].id);
  assert.match(decodeURIComponent(row.payment_uri), new RegExp(`message=${B.name} [0-9a-f]{8}: Lemonade`));
  assert.doesNotMatch(row.payment_uri, /send21/);
});

test("api mode still refuses to start without the live opt-in, naming dewby's env var", async () => {
  const { createApp } = await import("../server/app.js");
  assert.throws(() => createApp({ mode: "api", push: false, apiKey: "k", webhookSecret: "s" }), /APP_ALLOW_LIVE=1/);
});

test("pair's defaults are unchanged when no brand options are passed", async (t) => {
  const s = await start({}, createPairApp);
  t.after(() => s.close());
  assert.match((await s.call("GET", "/config.js")).text, /window\.SEND21_PAIR = /);
  assert.match((await s.call("GET", "/")).text, /send21 pair/);
  const u = await s.call("POST", "/api/users", { body: { name: "Alex", fiat: "SEK" } });
  const r = await s.call("POST", "/api/requests", { token: u.json.token, body: { kind: "link", amount: 5, clientKey: key() } });
  const row = s.app.db.prepare("SELECT payment_uri FROM requests WHERE id = ?").get(r.json.requests[0].id);
  assert.match(decodeURIComponent(row.payment_uri), /message=send21 pair /);
});
