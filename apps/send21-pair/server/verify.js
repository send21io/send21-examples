import { createHmac, timingSafeEqual } from "node:crypto";

// send21 signs every webhook delivery as documented in the Webhooks section of
// https://send21.io/swagger and at https://send21.io/docs/webhooks.
//
// Recommended, verify this one:
//
//   X-Send21-Signature-V2: t=<timestamp>,v1=<hex HMAC-SHA256 of "<timestamp>.<delivery id>.<raw body>">
//
// <timestamp> is Unix seconds (also sent as X-Send21-Timestamp) and <delivery id>
// is the X-Send21-Delivery header. Because the time and delivery id are signed
// too, a copied delivery cannot be replayed later: refuse deliveries whose
// timestamp is more than 5 minutes away from now.
//
// Legacy fallback, still sent for compatibility with existing integrations:
//
//   X-Send21-Signature: sha256=<lowercase hex HMAC-SHA256 of the raw body>
//
// It signs the raw body only (no timestamp, no delivery id), so it does not
// protect against replays. verifyDelivery uses it only when no V2 header is
// present, and you can turn the fallback off with { allowLegacy: false }.
//
// The secret is the signing secret returned once when you create the endpoint.
// Verify against the exact bytes you received. Parsing and re-serializing the
// JSON first changes the bytes and breaks the check.
export const SIGNATURE_V2_HEADER = "x-send21-signature-v2";
export const SIGNATURE_HEADER = "x-send21-signature";
export const TIMESTAMP_HEADER = "x-send21-timestamp";
export const EVENT_HEADER = "x-send21-event";
export const DELIVERY_HEADER = "x-send21-delivery";

/** Maximum age (and clock skew) of a V2 delivery, in seconds. */
export const TOLERANCE_SECONDS = 5 * 60;

const hmacHex = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  // timingSafeEqual throws on buffers of different length, so check that first.
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Build an X-Send21-Signature-V2 value: "t=<timestamp>,v1=<hex>".
 * Used by the tests and send-sample.js.
 * @param {Buffer | string} rawBody exact request body bytes
 * @param {string} deliveryId value of X-Send21-Delivery
 * @param {number} timestamp Unix seconds
 * @param {string} secret your webhook signing secret
 * @returns {string}
 */
export function signV2(rawBody, deliveryId, timestamp, secret) {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`), Buffer.from(rawBody)]);
  return `t=${timestamp},v1=${hmacHex(secret, signed)}`;
}

/**
 * Constant-time check of X-Send21-Signature-V2, including the 5-minute window.
 * A missing or malformed header returns false, it does not throw.
 * @param {Buffer | string} rawBody exact request body bytes
 * @param {string | string[] | undefined} header value of X-Send21-Signature-V2
 * @param {string | string[] | undefined} deliveryId value of X-Send21-Delivery
 * @param {string} secret your webhook signing secret
 * @param {{ now?: number, toleranceSeconds?: number }} [options] now in Unix seconds
 * @returns {boolean}
 */
export function verifySignatureV2(rawBody, header, deliveryId, secret, { now = Date.now() / 1000, toleranceSeconds = TOLERANCE_SECONDS } = {}) {
  if (!secret || typeof header !== "string" || typeof deliveryId !== "string" || !deliveryId) return false;
  const parts = {};
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) parts[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  if (!/^\d+$/.test(parts.t ?? "") || !parts.v1) return false;
  const timestamp = Number(parts.t);
  if (Math.abs(now - timestamp) > toleranceSeconds) return false;
  return safeEqual(parts.v1, signV2(rawBody, deliveryId, parts.t, secret).split(",v1=")[1]);
}

/**
 * Legacy: build an X-Send21-Signature value, "sha256=" + lowercase hex of the raw body.
 * @param {Buffer | string} rawBody exact request body bytes
 * @param {string} secret your webhook signing secret
 * @returns {string}
 */
export function sign(rawBody, secret) {
  return "sha256=" + hmacHex(secret, rawBody);
}

/**
 * Legacy: constant-time check of X-Send21-Signature against the raw body.
 * No timestamp and no delivery id are signed; prefer verifySignatureV2.
 * @param {Buffer | string} rawBody exact request body bytes
 * @param {string | string[] | undefined} header value of X-Send21-Signature
 * @param {string} secret your webhook signing secret
 * @returns {boolean}
 */
export function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== "string") return false;
  return safeEqual(header, sign(rawBody, secret));
}

/**
 * Verify a delivery from its headers: V2 first, legacy only when no V2 header is present.
 * @param {Buffer | string} rawBody exact request body bytes
 * @param {Record<string, string | string[] | undefined>} headers lower-cased request headers
 * @param {string} secret your webhook signing secret
 * @param {{ now?: number, toleranceSeconds?: number, allowLegacy?: boolean }} [options]
 * @returns {{ valid: boolean, scheme: "v2" | "v1" | null }}
 */
export function verifyDelivery(rawBody, headers, secret, { allowLegacy = true, ...options } = {}) {
  const v2 = headers[SIGNATURE_V2_HEADER];
  if (v2 !== undefined) {
    return { valid: verifySignatureV2(rawBody, v2, headers[DELIVERY_HEADER], secret, options), scheme: "v2" };
  }
  if (allowLegacy && headers[SIGNATURE_HEADER] !== undefined) {
    return { valid: verifySignature(rawBody, headers[SIGNATURE_HEADER], secret), scheme: "v1" };
  }
  return { valid: false, scheme: null };
}
