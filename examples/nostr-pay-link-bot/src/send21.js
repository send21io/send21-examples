// send21 helpers. Facts from https://send21.io/llms-full.txt and https://send21.io/swagger/v1/swagger.json.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SEND21_BASE_URL = "https://send21.io";
export const TOLERANCE_SECONDS = 300;
export const DECLINE_NOTE_MAX = 200;

export function cleanDeclineNote(note) {
  const text = String(note ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || "Nothing happens; the link just expires.";
  return text.length <= DECLINE_NOTE_MAX ? text : text.slice(0, DECLINE_NOTE_MAX - 1).trimEnd() + "…";
}

export function parseOptions(json) {
  const list = JSON.parse(json);
  if (!Array.isArray(list) || !list.length) throw new Error("SEND21_OPTIONS needs at least one receiving option");
  const currencies = ["Btc", "Usdc", "Usdt", "Eurc", "Sol", "Eth"];
  const networks = ["Mainnet", "Solana", "Ethereum", "Base", "Arbitrum", "Polygon"];
  return list.map((o, i) => {
    if (!currencies.includes(o?.currency) || !networks.includes(o?.network) || typeof o.address !== "string" || o.address.length < 3) {
      throw new Error(`option ${i + 1} is not valid`);
    }
    if (o.method !== undefined && !["MultiOutput", "Lightning"].includes(o.method)) throw new Error(`option ${i + 1}: unknown method`);
    return { currency: o.currency, network: o.network, address: o.address, ...(o.method ? { method: o.method } : {}) };
  });
}

/** Body + Idempotency-Key for POST /api/v1/payment-requests, one link per Nostr request event. */
export function buildPaymentRequest({ orderId, item, amount, currency }, options, { declineNote, expiryHours = 24 } = {}) {
  return {
    idempotencyKey: orderId,
    body: {
      fiatCurrency: currency,
      fiatAmount: amount,
      orderId,
      memo: item.slice(0, 140),
      expiryHours: Math.min(720, Math.max(1, Math.round(Number(expiryHours) || 24))),
      declineNote: cleanDeclineNote(declineNote),
      reuseOpenForOrder: true,
      options,
    },
  };
}

/** Body for POST /api/v1/payment-buttons: a reusable https://send21.io/b/<token> link. Nothing in it is secret. */
export function buildPaymentButton({ name, amount, currency, memo }, options) {
  return { name, fiatCurrency: currency, fiatAmount: amount, ...(memo ? { memo } : {}), options };
}

export async function send21Post(fetchImpl, apiKey, path, body, idempotencyKey) {
  const res = await fetchImpl(`${SEND21_BASE_URL}/api/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`send21 API ${res.status} on ${path}`);
  return res.json();
}

export function signV2(rawBody, deliveryId, timestamp, secret) {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.`).update(rawBody).digest("hex")}`;
}

export function verifySignatureV2(rawBody, header, deliveryId, secret, now = Date.now() / 1000) {
  if (!secret || typeof header !== "string" || typeof deliveryId !== "string" || !deliveryId) return false;
  const t = /(?:^|,)\s*t=(\d+)/.exec(header)?.[1];
  const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(header)?.[1];
  if (!t || !v1 || Math.abs(now - Number(t)) > TOLERANCE_SECONDS) return false;
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(signV2(rawBody, deliveryId, t, secret).split(",v1=")[1], "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
