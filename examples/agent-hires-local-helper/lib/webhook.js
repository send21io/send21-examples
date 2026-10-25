// Verify X-Send21-Signature-V2: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<delivery id>.<raw body>">.
// Refuse deliveries older than 300 seconds. See https://send21.io/docs/webhooks
import crypto from "node:crypto";

export function verifyV2({ rawBody, signatureHeader, deliveryId, secret, now = Date.now() / 1000 }) {
  if (!secret) return false;
  const sig = String(signatureHeader ?? "");
  const t = /(?:^|,)t=(\d+)/.exec(sig)?.[1];
  const v1 = /(?:^|,)v1=([0-9a-f]{64})/.exec(sig)?.[1];
  if (!t || !v1 || Math.abs(now - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${deliveryId ?? ""}.`).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(expected, "hex"));
}

export function signV2({ rawBody, deliveryId, secret, t = Math.floor(Date.now() / 1000) }) {
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${deliveryId}.`).update(rawBody).digest("hex");
  return `t=${t},v1=${v1}`;
}
