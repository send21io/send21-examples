import { randomUUID } from "node:crypto";
import { signV2 } from "../lib/verify.js";
import { createShopServer, loadConfig } from "../server.js";

export const SECRET = "whsec_test_secret";

export async function startShop(env = {}, deps = {}) {
  const config = loadConfig({ DRY_RUN: "1", SEND21_WEBHOOK_SECRET: SECRET, DATA_FILE: "", ...env });
  const shop = createShopServer(config, { log: () => {}, ...deps });
  await new Promise((resolve) => shop.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${shop.server.address().port}`;
  return { ...shop, base, close: () => new Promise((r) => shop.server.close(r)) };
}

export const json = async (url, body, method = body === undefined ? "GET" : "POST") => {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

export function postWebhook(base, payload, { delivery = randomUUID(), timestamp = Math.floor(Date.now() / 1000), secret = SECRET, tamper } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = {
    "content-type": "application/json",
    "x-send21-delivery": delivery,
    "x-send21-timestamp": String(timestamp),
    "x-send21-signature-v2": signV2(raw, delivery, timestamp, secret),
  };
  return fetch(`${base}/webhooks/send21`, { method: "POST", headers, body: tamper ? tamper(raw) : raw });
}

/** A draft.confirmed with the documented field list for an order. */
export function confirmedFor(order, pr, overrides = {}) {
  return {
    event: "draft.confirmed",
    data: {
      draftId: randomUUID(), status: "Confirmed", txId: "5KqZ9bQtest", confirmations: 1,
      sentCurrency: "USDC", network: "Solana", amountSats: 43740000, sentAmount: "43.740000",
      fiatCurrency: order.fiatCurrency, fiatAmount: order.fiatAmount, conversionRate: 0.92, rateSource: "coinbase",
      paymentRequestId: pr.paymentRequestId, orderId: order.orderId, occurredAt: new Date().toISOString(),
      ...overrides,
    },
  };
}
