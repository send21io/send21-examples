// send21 helpers. Facts from https://send21.io/llms-full.txt and https://send21.io/swagger/v1/swagger.json.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SEND21_BASE_URL = "https://send21.io";
export const TOLERANCE_SECONDS = 300;
export const DECLINE_NOTE_MAX = 200;
export const DEFAULT_DECLINE_NOTE = "The invoice stays open in our books.";

// send21's EVM networks. odoo-web3 syncs ERC-20 transfers from an Etherscan-compatible
// explorer, so these are the ones whose transfers it can import.
export const EVM_NETWORKS = ["Ethereum", "Base", "Arbitrum", "Polygon"] as const;
export const TOKENS = ["Usdc", "Usdt", "Eurc"] as const;
export type EvmNetwork = (typeof EVM_NETWORKS)[number];
export type Token = (typeof TOKENS)[number];
export type ReceiveOption = { currency: Token; network: EvmNetwork; address: string };

export const orderIdForInvoice = (moveId: number) => `odoo-web3-move-${moveId}`;
export const moveIdFromOrder = (orderId: unknown): number | null => {
  const m = /^odoo-web3-move-(\d+)$/.exec(String(orderId ?? ""));
  return m ? Number(m[1]) : null;
};

export function cleanDeclineNote(note?: string | null): string {
  const text = String(note ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || DEFAULT_DECLINE_NOTE;
  return text.length <= DECLINE_NOTE_MAX ? text : text.slice(0, DECLINE_NOTE_MAX - 1).trimEnd() + "…";
}

export function parseOptions(json: string): ReceiveOption[] {
  const list = JSON.parse(json);
  if (!Array.isArray(list) || list.length === 0) throw new Error("SEND21_OPTIONS needs at least one option");
  return list.map((o, i) => {
    if (!TOKENS.includes(o?.currency)) throw new Error(`option ${i + 1}: use Usdc, Usdt or Eurc (ERC-20 tokens odoo-web3 can sync)`);
    if (!EVM_NETWORKS.includes(o?.network)) throw new Error(`option ${i + 1}: use an EVM network (${EVM_NETWORKS.join(", ")})`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(o?.address))) throw new Error(`option ${i + 1}: address must be a 0x address`);
    return { currency: o.currency, network: o.network, address: o.address };
  });
}

/** Pay link for a customer invoice (account.move, out_invoice): POST /api/v1/payment-requests. */
export function buildInvoicePaymentRequest(
  invoice: { id: number; name: string; amount_residual: number; currency: string },
  options: ReceiveOption[],
  { declineNote, expiryHours = 24 }: { declineNote?: string; expiryHours?: number } = {}
) {
  const amount = Math.round(invoice.amount_residual * 100) / 100;
  if (!(amount > 0)) throw new Error(`${invoice.name} has nothing left to pay`);
  const orderId = orderIdForInvoice(invoice.id);
  return {
    idempotencyKey: `${orderId}-${amount.toFixed(2)}`,
    body: {
      fiatCurrency: invoice.currency.toUpperCase(),
      fiatAmount: amount,
      orderId,
      memo: invoice.name.slice(0, 140),
      expiryHours: Math.min(720, Math.max(1, Math.round(expiryHours || 24))),
      declineNote: cleanDeclineNote(declineNote),
      reuseOpenForOrder: true,
      options,
    },
  };
}

/**
 * Draft for a vendor bill (account.move, in_invoice): POST /api/v1/drafts.
 * The draft only describes the payment. A person signs and sends it from their own wallet
 * (or proposes it to the Safe), so no private key has to sit on the server.
 */
export function buildBillDraft(
  bill: { id: number; name: string; amount_residual: number; currency: string },
  receiver: { address: string; network: EvmNetwork; currency: Token }
) {
  const amount = Math.round(bill.amount_residual * 100) / 100;
  if (!(amount > 0)) throw new Error(`${bill.name} has nothing left to pay`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(receiver.address)) throw new Error("vendor wallet must be a 0x address");
  return {
    idempotencyKey: `odoo-web3-bill-${bill.id}-${amount.toFixed(2)}`,
    body: {
      receiverAddress: receiver.address,
      network: receiver.network,
      currency: receiver.currency,
      paymentMethod: "MultiOutput",
      singleOutput: true,
      fiatCurrency: bill.currency.toUpperCase(),
      fiatAmount: amount,
      memo: bill.name.slice(0, 140),
    },
  };
}

export function signV2(rawBody: Buffer | string, deliveryId: string, timestamp: number | string, secret: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.`).update(rawBody).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifySignatureV2(rawBody: Buffer | string, header: unknown, deliveryId: unknown, secret: string, now = Date.now() / 1000): boolean {
  if (!secret || typeof header !== "string" || typeof deliveryId !== "string" || !deliveryId) return false;
  const t = /(?:^|,)\s*t=(\d+)/.exec(header)?.[1];
  const v1 = /(?:^|,)\s*v1=([0-9a-f]{64})/.exec(header)?.[1];
  if (!t || !v1 || Math.abs(now - Number(t)) > TOLERANCE_SECONDS) return false;
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(signV2(rawBody, deliveryId, t, secret).split(",v1=")[1], "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function send21Post(fetchImpl: typeof fetch, apiKey: string, path: string, req: { body: unknown; idempotencyKey: string }) {
  const res = await fetchImpl(`${SEND21_BASE_URL}/api/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": req.idempotencyKey },
    body: JSON.stringify(req.body),
  });
  if (!res.ok) throw new Error(`send21 API ${res.status} on ${path}`);
  return res.json();
}
