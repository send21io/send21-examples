import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// White-label apps run this whole suite against their own server wrapper:
// APP_SERVER_MODULE=../dewby/server/app.js node --test test/  (see apps/dewby/test/shared-suite.test.js)
const serverModule = process.env.APP_SERVER_MODULE ? pathToFileURL(resolve(process.env.APP_SERVER_MODULE)).href : "../server/app.js";
export const { createApp } = await import(serverModule);

export const tmpDb = () => join(mkdtempSync(join(tmpdir(), "pair-test-")), "pair.sqlite");

export async function start(config = {}) {
  const app = createApp({ mode: "mock", dbFile: tmpDb(), push: false, simulateDelayMs: 0, log: () => {}, ...config });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return {
    app, base, call,
    async close() { app.close(); await new Promise((r) => server.close(r)); server.closeAllConnections?.(); },
  };
}

/** Sign up a user with given addresses, return { token, id, code }. */
export async function user(t, name, { fiat = "SEK", addresses } = {}) {
  const r = await t.call("POST", "/api/users", { body: { name, fiat, addresses } });
  const me = await t.call("GET", "/api/me", { token: r.json.token });
  return { token: r.json.token, id: r.json.user.id, code: me.json.user.pair_path.split("/p/")[1], name };
}

export async function pair(t, a, b) {
  const r = await t.call("POST", "/api/contacts", { token: b.token, body: { code: a.code } });
  if (r.status !== 200) throw new Error(`pair failed ${r.status} ${r.text}`);
}

export const key = () => crypto.randomUUID().replace(/-/g, "");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
