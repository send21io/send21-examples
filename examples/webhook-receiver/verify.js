import { createHmac, timingSafeEqual } from "node:crypto";

// send21 signs every webhook delivery with HMAC-SHA256 over the raw request
// body, using the webhook secret shown once when you create the endpoint:
//
//   X-Send21-Signature: sha256=<hex>
//
// Verify against the exact bytes you received. Parsing and re-serializing the
// JSON first changes the bytes and breaks the check.
export const SIGNATURE_HEADER = "x-send21-signature";

/**
 * @param {Buffer | string} rawBody exact request body bytes
 * @param {string | undefined} header value of the X-Send21-Signature header
 * @param {string} secret your webhook secret
 * @returns {boolean}
 */
export function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== "string") return false;
  const match = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!match) return false;
  const received = Buffer.from(match[1].toLowerCase(), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Build a signature header value. Used by the tests and send-sample.js.
 * @param {Buffer | string} rawBody
 * @param {string} secret
 */
export function sign(rawBody, secret) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
