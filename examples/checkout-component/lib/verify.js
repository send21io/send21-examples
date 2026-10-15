import { createHmac, timingSafeEqual } from "node:crypto";

// send21 webhook signature, as documented at https://send21.io/docs/webhooks
// and in the Webhooks section of https://send21.io/swagger:
//
//   X-Send21-Signature-V2: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<delivery id>.<raw body>">
//
// keyed with the endpoint's signing secret. The time and the X-Send21-Delivery
// id are signed too, so a copied delivery cannot be replayed later: refuse
// anything older than 300 seconds. Same check as examples/webhook-receiver.
// This shop only accepts V2; the legacy X-Send21-Signature (body only, no
// timestamp) is not used here.
export const TOLERANCE_SECONDS = 300;

const hmacHex = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  // timingSafeEqual throws on different lengths, so check that first.
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Build an X-Send21-Signature-V2 value. Used by the tests and the mock mode.
 * @param {Buffer|string} rawBody exact body bytes
 * @param {string} deliveryId X-Send21-Delivery
 * @param {number|string} timestamp Unix seconds
 * @param {string} secret signing secret
 */
export function signV2(rawBody, deliveryId, timestamp, secret) {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`), Buffer.from(rawBody)]);
  return `t=${timestamp},v1=${hmacHex(secret, signed)}`;
}

/**
 * Constant-time check of X-Send21-Signature-V2 including the 300 s window.
 * Never throws; a missing or malformed header returns false.
 * @param {Buffer|string} rawBody exact body bytes, before JSON parsing
 * @param {unknown} header X-Send21-Signature-V2
 * @param {unknown} deliveryId X-Send21-Delivery
 * @param {string} secret signing secret
 * @param {{ now?: number, toleranceSeconds?: number }} [options] now in Unix seconds
 */
export function verifySignatureV2(rawBody, header, deliveryId, secret, { now = Date.now() / 1000, toleranceSeconds = TOLERANCE_SECONDS } = {}) {
  if (!secret || typeof header !== "string" || typeof deliveryId !== "string" || !deliveryId) return false;
  const t = /(?:^|,)\s*t=(\d+)/.exec(header)?.[1];
  const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(header)?.[1];
  if (!t || !v1) return false;
  if (Math.abs(now - Number(t)) > toleranceSeconds) return false;
  const expected = signV2(rawBody, deliveryId, t, secret).split(",v1=")[1];
  return safeEqualHex(v1, expected);
}
