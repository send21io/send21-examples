// send21 helpers: pay link body, signature check. Facts from https://send21.io/llms-full.txt
// and https://send21.io/swagger/v1/swagger.json.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SEND21_BASE_URL = "https://send21.io";
export const TOLERANCE_SECONDS = 300;
export const DECLINE_NOTE_MAX = 200;
export const DEFAULT_DECLINE_NOTE = "The invoice stays open and late fees may apply as agreed.";
const CURRENCIES = ["Btc", "Usdc", "Usdt", "Eurc", "Sol", "Eth"];
const NETWORKS = ["Mainnet", "Solana", "Ethereum", "Base", "Arbitrum", "Polygon"];
const METHODS = ["MultiOutput", "Lightning"];

export const orderIdForInvoice = (invoiceId) => `invoiceninja-${invoiceId}`;
export const invoiceIdFromOrder = (orderId) => /^invoiceninja-([A-Za-z0-9]+)$/.exec(String(orderId ?? ""))?.[1] ?? null;

export function cleanDeclineNote(note) {
  const text = String(note ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || DEFAULT_DECLINE_NOTE;
  return text.length <= DECLINE_NOTE_MAX ? text : text.slice(0, DECLINE_NOTE_MAX - 1).trimEnd() + "…";
}

export function parseReceiveOptions(json) {
  const list = typeof json === "string" ? JSON.parse(json) : json;
  if (!Array.isArray(list) || list.length === 0) throw new Error("SEND21_OPTIONS needs at least one receiving option");
  return list.map((o, i) => {
    if (!CURRENCIES.includes(o?.currency)) throw new Error(`option ${i + 1}: unknown currency`);
    if (!NETWORKS.includes(o?.network)) throw new Error(`option ${i + 1}: unknown network`);
    if (typeof o.address !== "string" || o.address.trim().length < 3) throw new Error(`option ${i + 1}: address missing`);
    if (o.method !== undefined && !METHODS.includes(o.method)) throw new Error(`option ${i + 1}: unknown method`);
    return { currency: o.currency, network: o.network, address: o.address.trim(), ...(o.method ? { method: o.method } : {}) };
  });
}

/** Body + Idempotency-Key for POST /api/v1/payment-requests, for the open balance of an invoice. */
export function buildPaymentRequest({ invoiceId, number, balance, currency }, options, { declineNote, expiryHours = 24 } = {}) {
  const amount = Math.round(Number(balance) * 100) / 100;
  if (!(amount > 0)) throw new Error("invoice has no open balance");
  if (!/^[A-Z]{3}$/.test(String(currency))) throw new Error("invoice currency must be a 3-letter code");
  const orderId = orderIdForInvoice(invoiceId);
  return {
    idempotencyKey: `${orderId}-${amount.toFixed(2)}`,
    body: {
      fiatCurrency: currency,
      fiatAmount: amount,
      orderId,
      memo: `Invoice ${number ?? invoiceId}`.slice(0, 140),
      expiryHours: Math.min(720, Math.max(1, Math.round(Number(expiryHours) || 24))),
      declineNote: cleanDeclineNote(declineNote),
      reuseOpenForOrder: true,
      options,
    },
  };
}

export function payLink(payPath) {
  if (typeof payPath !== "string" || !payPath.startsWith("/")) throw new Error("payPath missing from send21 response");
  return SEND21_BASE_URL + payPath;
}

export function signV2(rawBody, deliveryId, timestamp, secret) {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifySignatureV2(rawBody, header, deliveryId, secret, now = Date.now() / 1000) {
  if (!secret || typeof header !== "string" || typeof deliveryId !== "string" || !deliveryId) return false;
  const t = /(?:^|,)\s*t=(\d+)/.exec(header)?.[1];
  const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(header)?.[1];
  if (!t || !v1 || Math.abs(now - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signV2(rawBody, deliveryId, t, secret).split(",v1=")[1], "hex");
  const got = Buffer.from(v1, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function safeEqualString(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export async function createPaymentRequest(fetchImpl, apiKey, request) {
  const res = await fetchImpl(`${SEND21_BASE_URL}/api/v1/payment-requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": request.idempotencyKey },
    body: JSON.stringify(request.body),
  });
  if (!res.ok) throw new Error(`send21 API ${res.status}`);
  return res.json();
}
