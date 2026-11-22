// Framework-free core of the send21 Cal.com app. No Cal.com imports here, so the
// rules below run (and are tested) on their own with `node --test`.
//
// Product facts come from https://send21.io/llms-full.txt and
// https://send21.io/swagger/v1/swagger.json:
// - POST /api/v1/payment-requests creates a pay link; share https://send21.io + payPath.
// - Send an Idempotency-Key; reuseOpenForOrder: true returns the open link for the same orderId.
// - declineNote is optional plain text, up to 200 characters, shown on the pay page as
//   "If you don't pay:".
// - expiryHours is 1 to 720 (default 24) and never moves once the link is created.
// - Webhooks are signed with X-Send21-Signature-V2 (t=<unix>,v1=<hex HMAC-SHA256 of
//   "<t>.<delivery id>.<raw body>">). Refuse deliveries older than 5 minutes.
// - Retries reuse X-Send21-Delivery. send21 does not dedupe for you: ignore ids you handled.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SEND21_BASE_URL = "https://send21.io";
export const TOLERANCE_SECONDS = 300;
export const DECLINE_NOTE_MAX = 200;
export const DEFAULT_DECLINE_NOTE = "The booking is released and the time slot opens for someone else.";

export const CURRENCIES = ["Btc", "Usdc", "Usdt", "Eurc", "Sol", "Eth"] as const;
export const NETWORKS = ["Mainnet", "Solana", "Ethereum", "Base", "Arbitrum", "Polygon"] as const;
export const METHODS = ["MultiOutput", "Lightning"] as const;

export type ReceiveOption = {
  currency: (typeof CURRENCIES)[number];
  network: (typeof NETWORKS)[number];
  address: string;
  method?: (typeof METHODS)[number];
};

// Cal.com stores prices in the smallest currency unit (cents). These have no minor unit.
const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF", "PYG", "RWF"]);

export function toMajorUnits(amountMinor: number, currency: string): number {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error("amount must be a positive integer in minor units");
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? amountMinor : amountMinor / 100;
}

export function orderIdForBooking(bookingId: number | string): string {
  return `cal-booking-${bookingId}`;
}

/** Plain text, one line, at most 200 characters (the send21 limit). */
export function cleanDeclineNote(note: string | undefined | null): string {
  const text = String(note ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const value = text || DEFAULT_DECLINE_NOTE;
  return value.length <= DECLINE_NOTE_MAX ? value : value.slice(0, DECLINE_NOTE_MAX - 1).trimEnd() + "…";
}

/** Validate the receiving options the owner saved in the app setup. */
export function parseReceiveOptions(input: unknown): ReceiveOption[] {
  const list = typeof input === "string" ? JSON.parse(input) : input;
  if (!Array.isArray(list) || list.length === 0) throw new Error("add at least one receiving option");
  return list.map((o, i) => {
    if (!o || typeof o !== "object") throw new Error(`option ${i + 1} is not an object`);
    const { currency, network, address, method } = o as Record<string, unknown>;
    if (!CURRENCIES.includes(currency as never)) throw new Error(`option ${i + 1}: unknown currency ${String(currency)}`);
    if (!NETWORKS.includes(network as never)) throw new Error(`option ${i + 1}: unknown network ${String(network)}`);
    if (typeof address !== "string" || address.trim().length < 3) throw new Error(`option ${i + 1}: address is missing`);
    if (method !== undefined && !METHODS.includes(method as never)) throw new Error(`option ${i + 1}: unknown method ${String(method)}`);
    const out: ReceiveOption = { currency: currency as ReceiveOption["currency"], network: network as ReceiveOption["network"], address: address.trim() };
    if (method) out.method = method as ReceiveOption["method"];
    return out;
  });
}

export type BookingForPayment = {
  bookingId: number;
  amountMinor: number;
  currency: string;
  title?: string;
  declineNote?: string | null;
  expiryHours?: number;
};

/** Body and Idempotency-Key for POST /api/v1/payment-requests. */
export function buildPaymentRequest(booking: BookingForPayment, options: ReceiveOption[]) {
  const orderId = orderIdForBooking(booking.bookingId);
  const expiryHours = Math.min(720, Math.max(1, Math.round(booking.expiryHours ?? 24)));
  const body = {
    fiatCurrency: booking.currency.toUpperCase(),
    fiatAmount: toMajorUnits(booking.amountMinor, booking.currency),
    orderId,
    memo: (booking.title || `Booking ${booking.bookingId}`).slice(0, 140),
    expiryHours,
    declineNote: cleanDeclineNote(booking.declineNote),
    reuseOpenForOrder: true,
    options,
  };
  return { body, idempotencyKey: orderId };
}

export function payLinkFromPath(payPath: string): string {
  if (typeof payPath !== "string" || !payPath.startsWith("/")) throw new Error("payPath missing from the send21 response");
  return SEND21_BASE_URL + payPath;
}

const hmacHex = (secret: string, data: Buffer) => createHmac("sha256", secret).update(data).digest("hex");

export function signV2(rawBody: Buffer | string, deliveryId: string, timestamp: number | string, secret: string): string {
  const signed = Buffer.concat([Buffer.from(`${timestamp}.${deliveryId}.`), Buffer.from(rawBody)]);
  return `t=${timestamp},v1=${hmacHex(secret, signed)}`;
}

/** Constant-time check of X-Send21-Signature-V2 with the 5-minute window. Never throws. */
export function verifySignatureV2(
  rawBody: Buffer | string,
  header: string | string[] | undefined,
  deliveryId: string | string[] | undefined,
  secret: string | undefined,
  now: number = Date.now() / 1000
): boolean {
  if (!secret || typeof header !== "string" || typeof deliveryId !== "string" || !deliveryId) return false;
  const t = /(?:^|,)\s*t=(\d+)/.exec(header)?.[1];
  const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(header)?.[1];
  if (!t || !v1) return false;
  if (Math.abs(now - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = signV2(rawBody, deliveryId, t, secret).split(",v1=")[1];
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type StoredPayment = {
  externalId: string; // send21 payment request id
  success: boolean;
  amountMinor: number;
  currency: string;
  bookingId: number;
  handledDeliveries?: string[];
};

export type WebhookDecision =
  | { action: "confirm"; txId: string; note: string }
  | { action: "release"; note: string }
  | { action: "review"; note: string }
  | { action: "ignore"; note: string };

const sameMoney = (a: unknown, b: number) => typeof a === "number" && Math.round(a * 100) === Math.round(b * 100);

/**
 * What a verified delivery means for the booking.
 * - draft.confirmed for this pay link, order and price: confirm the booking.
 * - payment_request.expired while unpaid: release the booking.
 * - draft.amount_mismatch: a differing amount arrived; the owner decides in send21
 *   (accept-received / reject-received). Keep the booking pending. Refunds are manual.
 */
export function decide(event: string, data: Record<string, unknown>, payment: StoredPayment): WebhookDecision {
  if (data.paymentRequestId && data.paymentRequestId !== payment.externalId) return { action: "ignore", note: "another pay link" };
  const orderId = orderIdForBooking(payment.bookingId);
  if (data.orderId !== undefined && data.orderId !== orderId) return { action: "ignore", note: "orderId does not match the booking" };

  switch (event) {
    case "draft.confirmed": {
      if (payment.success) return { action: "ignore", note: "already paid" };
      if (data.orderId !== orderId) return { action: "ignore", note: "confirmation without this booking's orderId" };
      const expected = toMajorUnits(payment.amountMinor, payment.currency);
      if (String(data.fiatCurrency ?? "").toUpperCase() !== payment.currency.toUpperCase() || !sameMoney(data.fiatAmount, expected)) {
        return { action: "review", note: `confirmed ${String(data.fiatAmount)} ${String(data.fiatCurrency)} but the booking costs ${expected} ${payment.currency.toUpperCase()}` };
      }
      return { action: "confirm", txId: String(data.txId ?? ""), note: `paid ${String(data.sentAmount ?? "")} ${String(data.sentCurrency ?? "")} on ${String(data.network ?? "")}`.trim() };
    }
    case "payment_request.expired":
      if (payment.success) return { action: "ignore", note: "already paid" };
      if (data.reviewState === "pending" || data.reviewState === "unresolved") {
        return { action: "review", note: "a transfer with a different amount arrived; decide in send21 before releasing" };
      }
      return { action: "release", note: data.opened ? "pay link expired unpaid (opened)" : "pay link expired unpaid" };
    case "draft.amount_mismatch":
    case "draft.mismatch_reminder":
    case "draft.mismatch_unresolved":
      return { action: "review", note: `${event}: a different amount arrived; accept or decline it in send21. Refunds are manual.` };
    default:
      return { action: "ignore", note: `event ${event} not used` };
  }
}

/** Keep the last 50 handled delivery ids on the payment record. */
export function rememberDelivery(handled: string[] | undefined, deliveryId: string): string[] {
  const list = (handled ?? []).filter((d) => d !== deliveryId);
  list.push(deliveryId);
  return list.slice(-50);
}

export function alreadyHandled(handled: string[] | undefined, deliveryId: string): boolean {
  return (handled ?? []).includes(deliveryId);
}
