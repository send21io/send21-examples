import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";

export const tmpDb = () => join(mkdtempSync(join(tmpdir(), "dewby-test-")), "db.sqlite");

export async function start(config = {}, factory = createApp) {
  const app = factory({ mode: "mock", dbFile: tmpDb(), push: false, simulateDelayMs: 0, log: () => {}, ...config });
  const server = createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, buf, headers: res.headers };
  };
  return { app, base, call, async close() { app.close(); await new Promise((r) => server.close(r)); server.closeAllConnections?.(); } };
}
export const key = () => crypto.randomUUID().replace(/-/g, "");
