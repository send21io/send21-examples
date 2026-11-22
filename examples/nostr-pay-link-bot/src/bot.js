// The Nostr side, kept free of relay I/O so it can be tested offline.
import { finalizeEvent, getPublicKey, nip17, nip19 } from "nostr-tools";

import { buildPaymentRequest, send21Post, SEND21_BASE_URL, verifySignatureV2 } from "./send21.js";

/** NOSTR_SECRET_KEY as nsec1... or 64 hex characters. Never commit it. */
export function secretKeyFrom(value) {
  const v = String(value ?? "").trim();
  if (v.startsWith("nsec1")) return nip19.decode(v).data;
  if (/^[0-9a-f]{64}$/i.test(v)) return Uint8Array.from(Buffer.from(v, "hex"));
  throw new Error("NOSTR_SECRET_KEY must be an nsec1... key or 64 hex characters");
}

/** Menu: {"coffee":{"amount":5,"currency":"EUR","label":"A coffee"}}. Payers can only pick these. */
export function parseMenu(json) {
  const menu = JSON.parse(json);
  for (const [key, item] of Object.entries(menu)) {
    if (!/^[a-z0-9-]{1,32}$/.test(key)) throw new Error(`menu key "${key}": use a-z, 0-9 and -`);
    if (!(Number(item.amount) > 0) || !/^[A-Z]{3}$/.test(item.currency)) throw new Error(`menu item ${key}: amount and 3-letter currency`);
  }
  return menu;
}

/** "pay coffee" -> { kind: "pay", key }, "menu"/"help" -> { kind: "menu" }. */
export function parseCommand(text) {
  const t = String(text ?? "").trim().toLowerCase();
  const m = /^(?:pay|buy)\s+([a-z0-9-]{1,32})$/.exec(t);
  if (m) return { kind: "pay", key: m[1] };
  if (/^(menu|help|\?)$/.test(t)) return { kind: "menu" };
  return { kind: "unknown" };
}

export function menuText(menu) {
  const lines = Object.entries(menu).map(([k, v]) => `pay ${k} - ${v.label ?? k}: ${v.amount} ${v.currency}`);
  return `Reply with one of:\n${lines.join("\n")}\nYou get a send21 pay link and sign and send from your own wallet.`;
}

/** At most `max` new links per sender per window, so a stranger cannot mass-create links. */
export function rateLimiter({ max = 3, windowMs = 60 * 60 * 1000 } = {}) {
  const hits = new Map();
  return (pubkey, now = Date.now()) => {
    const recent = (hits.get(pubkey) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(pubkey, recent);
    return true;
  };
}

export const orderIdForRumor = (rumorId) => `nostr-${rumorId}`;

/** A public kind-1 note that shares a pay link or a pay button (https://send21.io/b/<token>). */
export function payNote(secretKey, { text, url, createdAt = Math.floor(Date.now() / 1000) }) {
  if (!/^https:\/\/send21\.io\/(b|pay)\//.test(url)) throw new Error("share a send21 pay link or pay button URL");
  return finalizeEvent({ kind: 1, created_at: createdAt, tags: [["r", url]], content: `${text}\n\n${url}\n\nYou sign and send from your own wallet.` }, secretKey);
}

/**
 * Handle one incoming NIP-17 gift wrap (kind 1059). Returns the gift-wrapped reply to publish, or null.
 * deps: { secretKey, menu, options, config, fetchImpl, allow, links } where links is a Map orderId -> { pubkey }.
 */
export async function handleDirectMessage(wrap, deps) {
  let rumor;
  try {
    rumor = nip17.unwrapEvent(wrap, deps.secretKey);
  } catch {
    return null; // not for us or not decryptable
  }
  if (rumor.kind !== 14) return null;
  const sender = rumor.pubkey;
  const reply = (text) => nip17.wrapEvent(deps.secretKey, { publicKey: sender }, text, undefined, { eventId: rumor.id });
  const cmd = parseCommand(rumor.content);
  if (cmd.kind !== "pay") return reply(menuText(deps.menu));
  const item = deps.menu[cmd.key];
  if (!item) return reply(`No "${cmd.key}" on the menu.\n\n${menuText(deps.menu)}`);
  const orderId = orderIdForRumor(rumor.id);
  if (deps.links.has(orderId)) return null; // already answered (relays resend gift wraps after a restart)
  if (!deps.allow(sender)) return reply("Too many open requests from you right now. Try again later.");

  const req = buildPaymentRequest({ orderId, item: item.label ?? cmd.key, amount: Number(item.amount), currency: item.currency }, deps.options, deps.config);
  const pr = await send21Post(deps.fetchImpl ?? fetch, deps.config.send21ApiKey, "payment-requests", req.body, req.idempotencyKey);
  if (typeof pr.payPath !== "string" || !pr.payPath.startsWith("/")) throw new Error("send21 returned no payPath");
  deps.links.set(orderId, { pubkey: sender, paymentRequestId: pr.id, amount: Number(item.amount), currency: item.currency });
  return reply(`${item.label ?? cmd.key}: ${item.amount} ${item.currency}\n${SEND21_BASE_URL}${pr.payPath}\nPick a coin, then sign and send from your own wallet. I will message you when it confirms.`);
}

/**
 * send21 webhook -> a NIP-17 DM to the payer. Verify first; ignore handled X-Send21-Delivery ids
 * (send21 does not dedupe). Returns { status, dm } where dm is a gift wrap to publish, or null.
 */
export function handleWebhook({ headers, body }, deps) {
  const deliveryId = headers["x-send21-delivery"];
  if (!verifySignatureV2(body, headers["x-send21-signature-v2"], deliveryId, deps.config.send21WebhookSecret, deps.now)) return { status: 401, dm: null };
  if (deps.deliveries.has(deliveryId)) return { status: 200, dm: null };
  deps.deliveries.add(deliveryId);

  const { event, data = {} } = JSON.parse(body.toString("utf8"));
  const link = deps.links.get(data.orderId);
  if (!link || (data.paymentRequestId && link.paymentRequestId && data.paymentRequestId !== link.paymentRequestId)) return { status: 200, dm: null };
  let text = null;
  if (event === "draft.confirmed") {
    const exact = String(data.fiatCurrency).toUpperCase() === link.currency && Math.round(Number(data.fiatAmount) * 100) === Math.round(link.amount * 100);
    text = exact ? `Payment confirmed: ${data.sentAmount} ${data.sentCurrency} on ${data.network}. Thank you!` : "A payment arrived; I will check it and get back to you.";
  } else if (event === "payment_request.expired") {
    text = "Your pay link expired unpaid. Send the same command again for a new one.";
  } else if (event === "draft.amount_mismatch") {
    text = "A payment with a different amount arrived. I will look at it and get back to you.";
  }
  return { status: 200, dm: text ? nip17.wrapEvent(deps.secretKey, { publicKey: link.pubkey }, text) : null };
}

export const npubOf = (secretKey) => nip19.npubEncode(getPublicKey(secretKey));
