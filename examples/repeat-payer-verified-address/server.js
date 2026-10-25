// Web UI + small API for the repeat-payer example. The send21 key stays here, on the server.
//   npm start   then open http://localhost:3021
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { loadEnv } from "./lib/env.js";
import { client, Send21Error } from "./lib/send21.js";
import { loadPayee, resolveApproval } from "./lib/payee.js";
import { createMonthlyDraft, monthKey } from "./lib/monthly.js";
import { chunk } from "./lib/address.js";
import { verifyV2 } from "./lib/webhook.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
loadEnv(dir);
const api = client();
const payee = loadPayee(dir);
const port = Number(process.env.PORT || 3021);

// Confirmations that arrived over the signed webhook, by draft id.
const paidByWebhook = new Map();
const handledDeliveries = new Set(); // our own receiver ignores a delivery id it already handled

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((ok, fail) => { const parts = []; req.on("data", (c) => parts.push(c)); req.on("end", () => ok(Buffer.concat(parts))); req.on("error", fail); });
}

function publicPayee() {
  const { file, fileName, ...p } = payee;
  return { ...p, chunks: chunk(p.address), month: monthKey() };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/api/payee") {
      return json(res, 200, { payee: publicPayee(), approval: await resolveApproval(api, payee) });
    }
    if (req.method === "POST" && url.pathname === "/api/monthly") {
      const r = await createMonthlyDraft(api, payee);
      const qr = r.draft.paymentUri ? await QRCode.toString(r.draft.paymentUri, { type: "svg", margin: 1, color: { dark: "#1B1C20", light: "#FFFFFF" } }) : null;
      return json(res, 201, {
        draft: { id: r.draft.id, status: r.draft.status, network: r.draft.network, currency: r.draft.currency, fiatCurrency: r.draft.fiatCurrency, fiatAmount: r.draft.fiatAmount, amountBaseUnits: r.draft.amountBaseUnits, receiverAddress: r.draft.receiverAddress, paymentUri: r.draft.paymentUri, expiresAt: r.draft.expiresAt, lockedUntil: r.draft.quote?.lockedUntil ?? r.draft.quote?.expiresAt ?? null, memo: r.draft.memo },
        requoted: r.requoted,
        checks: r.checks, idempotencyKey: r.idempotencyKey, qr,
      });
    }
    const m = /^\/api\/drafts\/([0-9a-f-]{36})\/status$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const s = await api.get(`/drafts/${m[1]}/status`);
      return json(res, 200, { ...s, webhook: paidByWebhook.get(m[1]) ?? null });
    }
    if (req.method === "POST" && url.pathname === "/webhooks/send21") {
      const raw = await readBody(req);
      const delivery = String(req.headers["x-send21-delivery"] ?? "");
      const sig = req.headers["x-send21-signature-v2"];
      const real = verifyV2({ rawBody: raw, signatureHeader: sig, deliveryId: delivery, secret: process.env.SEND21_WEBHOOK_SECRET });
      const local = !real && verifyV2({ rawBody: raw, signatureHeader: sig, deliveryId: delivery, secret: process.env.LOCAL_TEST_WEBHOOK_SECRET });
      if (!real && !local) { res.writeHead(401); return res.end(); }
      if (handledDeliveries.has(delivery)) { res.writeHead(200); return res.end("already handled"); }
      handledDeliveries.add(delivery);
      const { event, data } = JSON.parse(raw.toString("utf8"));
      // Only trust a confirmation for the payee and asset we expect.
      if (event === "draft.confirmed" && data?.draftId && String(data.sentCurrency).toLowerCase() === payee.currency.toLowerCase() && data.network === payee.network) {
        paidByWebhook.set(data.draftId, { txId: data.txId, confirmedAt: data.confirmedAt, localTest: local });
      }
      res.writeHead(200); return res.end("ok");
    }
    // static files
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (req.method === "GET" && /^\/[\w.-]+$/.test(path)) {
      const body = await readFile(join(dir, "public", path)).catch(() => null);
      if (body) { res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" }); return res.end(body); }
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    const status = err instanceof Send21Error ? err.status : 500;
    json(res, status >= 400 && status < 600 ? status : 500, { error: err.message.replace(/s21_[A-Za-z0-9_-]+/g, "s21_[hidden]"), detail: err.body ?? null });
  }
});

server.listen(port, () => console.log(`repeat-payer-verified-address on http://localhost:${port}  (payee: ${payee.label}, ${payee.currency} on ${payee.network})`));
