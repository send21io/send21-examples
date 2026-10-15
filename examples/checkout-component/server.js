// send21 checkout example: the shop's own backend.
//
//   POST /orders                    demo cart -> order with a server-side total
//   POST /checkout                  create (or reuse) the send21 pay link for an order
//   GET  /checkout/:orderId/status  what <send21-checkout> polls
//   POST /webhooks/send21           X-Send21-Signature-V2 verified; draft.confirmed marks the order paid
//
// The send21 API key, the receive addresses and the prices live here, on the
// server. The browser only ever sends an order id (and the amount it shows,
// which is checked against the stored order). No npm dependencies are required;
// "qrcode" is optional and only draws the QR image.
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySignatureV2, signV2 } from "./lib/verify.js";
import { parseOptions, describeOption } from "./lib/options.js";
import { createStore } from "./lib/store.js";
import { createSend21Client, createMockClient } from "./lib/send21.js";
import { applyEvent } from "./lib/webhook.js";

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = join(root, "public");

// Demo catalog. Prices come from here, never from the browser.
export const CATALOG = {
  "mug-21": { sku: "mug-21", name: "Enamel mug, orange", price: 18.0 },
  "tee-21": { sku: "tee-21", name: "T-shirt, charcoal", price: 29.0 },
  "stickers": { sku: "stickers", name: "Sticker pack", price: 4.5 },
};

// Placeholder addresses for mock mode only. They are never sent to send21.
const MOCK_OPTIONS = "Usdc:Solana:MockSolanaReceiveAddress,Usdt:Solana:MockSolanaReceiveAddress,Usdc:Base:0xMockBaseReceiveAddress,Usdt:Ethereum:0xMockEthereumReceiveAddress,Btc:Mainnet:mock@lightning.example:Lightning";

export function loadConfig(env = process.env) {
  const apiKey = env.SEND21_API_KEY ?? "";
  const dryRun = env.DRY_RUN === "1" || env.DRY_RUN === "true" || !apiKey;
  const config = {
    port: Number(env.PORT) || 5930,
    dryRun,
    apiBase: (env.SEND21_API_BASE || "https://send21.io").replace(/\/$/, ""),
    apiKey,
    webhookSecret: env.SEND21_WEBHOOK_SECRET || (dryRun ? randomBytes(32).toString("hex") : ""),
    options: parseOptions(env.SEND21_OPTIONS || (dryRun ? MOCK_OPTIONS : "")),
    currency: (env.SHOP_CURRENCY || "EUR").toUpperCase(),
    expiryHours: Number(env.SEND21_EXPIRY_HOURS) || 1,
    acceptDifferentAmount: env.ACCEPT_DIFFERENT_AMOUNT === "1",
    publicUrl: (env.PUBLIC_URL ?? "").replace(/\/$/, ""),
    dataFile: env.DATA_FILE === "" ? null : (env.DATA_FILE ?? join(root, "data", "orders.json")),
  };
  if (!dryRun) {
    if (!config.webhookSecret) throw new Error("SEND21_WEBHOOK_SECRET is required outside DRY_RUN");
    if (config.options.length === 0) throw new Error("SEND21_OPTIONS is required outside DRY_RUN (Currency:Network:Address, ...)");
  }
  return config;
}

let qrModule;
async function qrDataUrl(text) {
  if (qrModule === undefined) qrModule = await import("qrcode").then((m) => m.default ?? m).catch(() => null);
  if (!qrModule) return null;
  const svg = await qrModule.toString(text, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#1B1C20", light: "#FEF8EC" } });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const cents = (n) => Math.round(Number(n) * 100);
const ORDER_ID_RE = /^ord_[0-9a-f]{16}$/;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": json ? "application/json" : "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  try { return JSON.parse((await readBody(req)).toString("utf8") || "{}"); }
  catch (e) { throw Object.assign(new Error("invalid JSON"), { status: e.status ?? 400 }); }
}

/**
 * Build the shop server. Exported for the tests.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{ client?: object, store?: object, log?: (l: string) => void }} [deps]
 */
export function createShopServer(config, { client, store, log = console.log } = {}) {
  client ??= config.dryRun ? createMockClient() : createSend21Client({ apiBase: config.apiBase, apiKey: config.apiKey });
  store ??= createStore(config.dataFile);
  const lastRefresh = new Map();
  let server;

  const origin = (req) => config.publicUrl || `http://${req.headers.host ?? `localhost:${config.port}`}`;
  const payUrlFor = (req, payPath) => (client.mode === "mock" ? origin(req) : client.payBase) + payPath;

  // What the browser may see about an order: no addresses, no keys.
  function publicView(order) {
    return {
      orderId: order.orderId,
      status: order.status,
      fiatAmount: order.fiatAmount,
      fiatCurrency: order.fiatCurrency,
      payUrl: order.payUrl ?? null,
      expiresAt: order.expiresAt ?? null,
      assets: order.options.map(describeOption),
      txId: order.status === "paid" ? order.txId : undefined,
      mode: client.mode,
    };
  }

  async function createOrder(req, res) {
    const { items } = await readJson(req);
    if (!Array.isArray(items) || items.length === 0 || items.length > 20) return send(res, 400, { error: "items required" });
    const lines = [];
    for (const { sku, qty } of items) {
      const product = CATALOG[sku];
      const n = Number(qty);
      if (!product || !Number.isInteger(n) || n < 1 || n > 99) return send(res, 400, { error: `bad item ${sku}` });
      lines.push({ sku, name: product.name, qty: n, price: product.price });
    }
    const total = lines.reduce((s, l) => s + cents(l.price) * l.qty, 0) / 100;
    const order = store.putOrder({
      orderId: `ord_${randomBytes(8).toString("hex")}`,
      lines,
      fiatAmount: total,
      fiatCurrency: config.currency,
      options: config.options, // fixed server-side, copied onto the order
      status: "created",
      paymentRequestIds: [],
      createdAt: new Date().toISOString(),
    });
    send(res, 201, { orderId: order.orderId, fiatAmount: order.fiatAmount, fiatCurrency: order.fiatCurrency, lines });
  }

  async function checkout(req, res) {
    const { orderId, amount, currency } = await readJson(req);
    const order = typeof orderId === "string" && ORDER_ID_RE.test(orderId) ? store.getOrder(orderId) : null;
    if (!order) return send(res, 404, { error: "unknown order" });
    // The amount shown in the browser must be the stored total. The server
    // never prices from it; this only catches a stale or tampered page.
    if (amount !== undefined && cents(amount) !== cents(order.fiatAmount)) return send(res, 409, { error: "amount does not match the order" });
    if (currency !== undefined && String(currency).toUpperCase() !== order.fiatCurrency) return send(res, 409, { error: "currency does not match the order" });
    if (order.status === "paid" || order.status === "review") return send(res, 200, publicView(order));
    if (order.payUrl && order.status !== "expired" && new Date(order.expiresAt) > new Date()) return send(res, 200, { ...publicView(order), qr: await qrDataUrl(order.payUrl) });

    // A fresh Idempotency-Key per order attempt: a retry of the same attempt
    // reuses it and gets the same pay link back; a new attempt (after expiry)
    // gets a new key. reuseOpenForOrder makes send21 return the open link for
    // this orderId instead of creating a second one.
    const attempt = order.status === "expired" || !order.idempotencyKey;
    const idempotencyKey = attempt ? `checkout-${order.orderId}-${randomUUID()}` : order.idempotencyKey;
    const requestBody = {
      fiatCurrency: order.fiatCurrency,
      fiatAmount: order.fiatAmount,
      orderId: order.orderId,
      memo: `Order ${order.orderId}`,
      expiryHours: config.expiryHours,
      reuseOpenForOrder: true,
      options: order.options.map(({ currency: c, network, address, method }) => ({ currency: c, network, address, ...(method ? { method } : {}) })),
    };
    store.putOrder({ ...order, idempotencyKey });
    let pr;
    try {
      pr = await client.createPaymentRequest(requestBody, idempotencyKey);
    } catch (e) {
      log(`order ${order.orderId}: creating the pay link failed: ${e.message}`);
      return send(res, 502, { error: "could not create the pay link, try again" });
    }
    // Trust but verify: the link must be for this order, amount and our addresses.
    const sameOptions = (pr.options ?? []).length === requestBody.options.length &&
      requestBody.options.every((o) => pr.options.some((p) => p.currency === o.currency && p.network === o.network && p.address === o.address));
    if (pr.orderId !== order.orderId || cents(pr.fiatAmount) !== cents(order.fiatAmount) ||
        String(pr.fiatCurrency).toUpperCase() !== order.fiatCurrency || !sameOptions || !String(pr.payPath ?? "").startsWith("/")) {
      log(`order ${order.orderId}: send21 returned a pay link that does not match the order; refusing it`);
      return send(res, 502, { error: "pay link did not match the order" });
    }
    const payUrl = payUrlFor(req, pr.payPath);
    const updated = store.putOrder({
      ...store.getOrder(order.orderId),
      status: "awaiting_payment",
      paymentRequestId: pr.id,
      paymentRequestIds: [...new Set([...(order.paymentRequestIds ?? []), pr.id])],
      shareToken: pr.shareToken,
      payUrl,
      expiresAt: pr.expiresAt,
    });
    log(`order ${order.orderId}: pay link ${pr.id} (${order.fiatAmount} ${order.fiatCurrency})`);
    send(res, 200, { ...publicView(updated), qr: await qrDataUrl(payUrl) });
  }

  async function status(res, orderId) {
    let order = ORDER_ID_RE.test(orderId) ? store.getOrder(orderId) : null;
    if (!order) return send(res, 404, { error: "unknown order" });
    if (["awaiting_payment", "seen"].includes(order.status)) {
      if (order.expiresAt && new Date(order.expiresAt) <= new Date()) {
        order = store.putOrder({ ...order, status: "expired" });
      } else if (client.mode === "live" && Date.now() - (lastRefresh.get(orderId) ?? 0) > 15_000) {
        // Webhooks are the source of truth for "paid". This read only notices
        // an expired or cancelled link, or a payment seen on chain, and is
        // throttled to stay far below the 300 requests/minute limit.
        lastRefresh.set(orderId, Date.now());
        try {
          const pr = await client.getPaymentRequest(order.paymentRequestId);
          if (pr?.status === "Expired" || pr?.status === "Cancelled") order = store.putOrder({ ...order, status: "expired" });
          else if (pr?.draftStatus === "Seen" && order.status === "awaiting_payment") order = store.putOrder({ ...order, status: "seen" });
        } catch (e) { log(`order ${orderId}: status read failed: ${e.message}`); }
      }
    }
    send(res, 200, publicView(order));
  }

  async function webhook(req, res) {
    const raw = await readBody(req, 256 * 1024);
    const deliveryId = req.headers["x-send21-delivery"];
    if (!verifySignatureV2(raw, req.headers["x-send21-signature-v2"], deliveryId, config.webhookSecret)) {
      return send(res, 401, { error: "bad signature" });
    }
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: "invalid JSON" }); }
    // Retries reuse X-Send21-Delivery. Only verified deliveries are remembered.
    if (store.hasDelivery(deliveryId)) return send(res, 200, { ok: true, outcome: "duplicate" });
    const outcome = applyEvent(body, store, { log, acceptDifferentAmount: config.acceptDifferentAmount });
    store.addDelivery(deliveryId, outcome);
    send(res, 200, { ok: true, outcome });
  }

  // ---- Mock mode only: a stand-in for the send21 pay page ----
  async function mockSimulate(req, res, token) {
    const entry = [...client.requests.values()].find((e) => e.response.shareToken === token);
    if (!entry) return send(res, 404, { error: "unknown pay link" });
    const { outcome = "confirmed", asset = 0 } = await readJson(req);
    const pr = entry.response;
    const option = pr.options[Number(asset)] ?? pr.options[0];
    const decimals = { Btc: 8, Usdc: 6, Usdt: 6, Eurc: 6, Sol: 9, Eth: 9 }[option.currency];
    const usdPer = { Btc: 60000, Usdc: 1, Usdt: 1, Eurc: 1.08, Sol: 150, Eth: 3000 }[option.currency];
    const fiatUsd = { EUR: 1.08, USD: 1, SEK: 0.095, GBP: 1.27 }[pr.fiatCurrency] ?? 1;
    const amount = (pr.fiatAmount * fiatUsd) / usdPer;
    const amountSats = Math.round(amount * 10 ** decimals);
    const sentCurrency = option.currency === "Btc" ? "BTC" : option.currency.toUpperCase();
    const data = {
      draftId: randomUUID(), status: "Confirmed", txId: `mock-${randomBytes(6).toString("hex")}`, confirmations: 1,
      sentCurrency, network: option.network, amountSats, sentAmount: (amountSats / 10 ** decimals).toFixed(decimals),
      fiatCurrency: pr.fiatCurrency, fiatAmount: pr.fiatAmount, conversionRate: fiatUsd / usdPer, rateSource: "mock",
      paymentRequestId: pr.id, orderId: pr.orderId, occurredAt: new Date().toISOString(),
    };
    let body;
    if (outcome === "confirmed") body = { event: "draft.confirmed", data };
    else if (outcome === "wrong-amount") body = { event: "draft.confirmed", data: { ...data, fiatAmount: Math.max(0.01, pr.fiatAmount - 5) } };
    else if (outcome === "wrong-asset") body = { event: "draft.confirmed", data: { ...data, sentCurrency: "USDT", network: "Polygon" } };
    else if (outcome === "seen") body = { event: "draft.seen", data: { ...data, status: "Seen" } };
    else if (outcome === "expired") { pr.status = "Expired"; body = { event: "payment_request.expired", data: { paymentRequestId: pr.id, orderId: pr.orderId, opened: true, quoteRequested: false, occurredAt: data.occurredAt } }; }
    else return send(res, 400, { error: "unknown outcome" });
    if (outcome === "confirmed") pr.status = "Completed";
    // Sign it like send21 does and post it to our own webhook endpoint.
    const raw = JSON.stringify(body);
    const delivery = randomUUID();
    const t = Math.floor(Date.now() / 1000);
    const r = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/send21`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-send21-event": body.event, "x-send21-delivery": delivery, "x-send21-timestamp": String(t), "x-send21-signature-v2": signV2(raw, delivery, t, config.webhookSecret) },
      body: raw,
    });
    send(res, 200, { webhookStatus: r.status, ...(await r.json()) });
  }

  async function staticFile(res, path) {
    const file = normalize(join(publicDir, path === "/" ? "index.html" : path));
    if (!file.startsWith(publicDir + "/") || !TYPES[extname(file)]) return send(res, 404, { error: "not found" });
    try {
      const content = await readFile(file);
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": TYPES[extname(file)], "cache-control": "no-cache" });
      res.end(content);
    } catch { send(res, 404, { error: "not found" }); }
  }

  server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (req.method === "GET" && pathname === "/healthz") return send(res, 200, { ok: true, mode: client.mode });
      if (req.method === "GET" && pathname === "/products") return send(res, 200, { currency: config.currency, mode: client.mode, products: Object.values(CATALOG) });
      if (req.method === "POST" && pathname === "/orders") return await createOrder(req, res);
      if (req.method === "POST" && pathname === "/checkout") return await checkout(req, res);
      const m = /^\/checkout\/([^/]+)\/status$/.exec(pathname);
      if (req.method === "GET" && m) return await status(res, decodeURIComponent(m[1]));
      if (req.method === "POST" && pathname === "/webhooks/send21") return await webhook(req, res);
      if (client.mode === "mock") {
        const p = /^\/mock\/pay\/([A-Za-z0-9_-]+)(\/simulate)?$/.exec(pathname);
        if (p && req.method === "GET" && !p[2]) return await staticFile(res, "/mock-pay.html");
        if (p && req.method === "POST" && p[2]) return await mockSimulate(req, res, p[1]);
        const info = /^\/mock\/pay\/([A-Za-z0-9_-]+)\/info$/.exec(pathname);
        if (info && req.method === "GET") {
          const e = [...client.requests.values()].find((x) => x.response.shareToken === info[1]);
          if (!e) return send(res, 404, { error: "unknown pay link" });
          return send(res, 200, { orderId: e.response.orderId, fiatAmount: e.response.fiatAmount, fiatCurrency: e.response.fiatCurrency, status: e.response.status, assets: e.response.options.map(describeOption) });
        }
      }
      if (req.method === "GET") return await staticFile(res, pathname);
      send(res, 404, { error: "not found" });
    } catch (e) {
      if (e.status) return send(res, e.status, { error: e.message });
      log(`${req.method} ${req.url} failed: ${e.stack}`);
      send(res, 500, { error: "internal error" });
    }
  });
  return { server, store, client, config };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const config = loadConfig();
  const { server } = createShopServer(config);
  server.listen(config.port, () => {
    console.log(`send21 checkout example on http://localhost:${config.port} (${config.dryRun ? "DRY_RUN: mock send21, no API key used" : `live, ${config.apiBase}`})`);
    console.log(`accepting: ${config.options.map((o) => describeOption(o).label).join(", ")}`);
  });
}
