import { createHmac, timingSafeEqual } from "node:crypto";

// send21 signs every webhook delivery as documented in the Webhooks section of
// https://send21.io/swagger:
//
//   X-Send21-Signature: sha256=<lowercase hex HMAC-SHA256 of the raw body, keyed with your secret>
//
// The secret is the signing secret returned once when you create the endpoint.
// Verify against the exact bytes you received. Parsing and re-serializing the
// JSON first changes the bytes and breaks the check.
//
// The docs define no timestamp header, so there is no timestamp window to
// check. Use X-Send21-Delivery to ignore repeated deliveries (see server.js).
export const SIGNATURE_HEADER = "x-send21-signature";
export const EVENT_HEADER = "x-send21-event";
export const DELIVERY_HEADER = "x-send21-delivery";

/**
 * Build the expected header value: "sha256=" + lowercase hex digest.
 * Used by verifySignature, the tests and send-sample.js.
 * @param {Buffer | string} rawBody exact request body bytes
 * @param {string} secret your webhook signing secret
 * @returns {string}
 */
export function sign(rawBody, secret) {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time check of the X-Send21-Signature header against the raw body.
 * The length check comes first because timingSafeEqual throws on buffers of
 * different length, and a missing or malformed header must return false, not throw.
 * @param {Buffer | string} rawBody exact request body bytes
 * @param {string | string[] | undefined} header value of the X-Send21-Signature header
 * @param {string} secret your webhook signing secret
 * @returns {boolean}
 */
export function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== "string") return false;
  const expected = Buffer.from(sign(rawBody, secret));
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
