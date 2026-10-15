import { createCipheriv, createECDH, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Web Push without a dependency: VAPID (RFC 8292) and aes128gcm payload
// encryption (RFC 8291 / RFC 8188), with node:crypto only.

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** Load or create the VAPID key pair (P-256), kept in the data folder, never committed. */
export function loadVapid(file) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  const vapid = { publicKey, jwk };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(vapid), { mode: 0o600 });
  return vapid;
}

/** ES256 JWT for the push service's origin. */
export function vapidAuthorization(endpoint, vapid, subject = "mailto:info@send21.io", now = Math.floor(Date.now() / 1000)) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: subject }));
  const key = createPrivateKey({ key: vapid.jwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/**
 * Encrypt a payload for one subscription (RFC 8291, single record).
 * @param {Buffer|string} payload
 * @param {{ p256dh: string, auth: string }} keys from PushSubscription.toJSON().keys
 */
export function encryptPayload(payload, keys, { salt = randomBytes(16), serverKeys } = {}) {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  const ecdh = serverKeys ?? createECDH("prime256v1");
  if (!serverKeys) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo); // HKDF-Expand, L = 32
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/**
 * Send one push. Returns the HTTP status; 404/410 mean the subscription is gone.
 * @param {{ endpoint: string, p256dh: string, auth: string }} sub
 */
export async function sendPush(sub, data, vapid, { fetch: fetchImpl = globalThis.fetch, ttl = 3600 } = {}) {
  const body = encryptPayload(JSON.stringify(data), { p256dh: sub.p256dh, auth: sub.auth });
  const res = await fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
      Authorization: vapidAuthorization(sub.endpoint, vapid),
    },
    body,
  });
  return res.status;
}
