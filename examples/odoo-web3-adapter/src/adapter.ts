// The adapter. Inbound: send21 confirmations enrich the statement lines odoo-web3 synced,
// the same way its Monerium step does (partner_id, payment_ref, transaction_details), so its
// reconciliation (reference + amount) matches the invoice. Outbound: vendor bills become send21
// drafts that a person signs and sends from their own wallet; no private key on the server.
import type { Odoo } from "./odoo.ts";
import {
  buildBillDraft,
  buildInvoicePaymentRequest,
  moveIdFromOrder,
  type EvmNetwork,
  type ReceiveOption,
  send21Post,
  SEND21_BASE_URL,
  type Token,
  verifySignatureV2,
} from "./send21.ts";
import type { Store } from "./store.ts";

export type Config = {
  send21ApiKey: string;
  send21WebhookSecret: string;
  options: ReceiveOption[];
  declineNote?: string;
  expiryHours?: number;
  journalId: number;
};
export type Deps = { odoo: Odoo; store: Store; config: Config; fetchImpl?: typeof fetch; now?: number };

/** odoo-web3 import ids: "chain:wallet:0xhash:logIndex" (new), "chain:0xhash:logIndex" (old) or "0xhash". */
export function txHashFromImportId(importId: unknown): string | null {
  const parts = String(importId ?? "").toLowerCase().split(":");
  return parts.find((p) => /^0x[0-9a-f]{64}$/.test(p)) ?? null;
}

const readMove = async (odoo: Odoo, id: number) => {
  const [move] = await odoo.executeKw("account.move", "read", [[id]], {
    fields: ["name", "move_type", "state", "amount_residual", "currency_id", "partner_id", "payment_state"],
  });
  if (!move) throw new Error(`account.move ${id} not found`);
  return { ...move, currency: Array.isArray(move.currency_id) ? move.currency_id[1] : String(move.currency_id) };
};

export async function createInvoicePayLink(moveId: number, { odoo, store, config, fetchImpl = fetch }: Deps) {
  const move = await readMove(odoo, moveId);
  if (move.move_type !== "out_invoice" || move.state !== "posted") throw new Error(`${move.name} is not a posted customer invoice`);
  const req = buildInvoicePaymentRequest({ id: moveId, name: move.name, amount_residual: move.amount_residual, currency: move.currency }, config.options, config);
  const pr = await send21Post(fetchImpl, config.send21ApiKey, "payment-requests", req);
  if (typeof pr.payPath !== "string" || !pr.payPath.startsWith("/")) throw new Error("send21 returned no payPath");
  const link = SEND21_BASE_URL + pr.payPath;
  const st = store.read();
  st.links[req.body.orderId] = { amount: req.body.fiatAmount, currency: req.body.fiatCurrency, paymentRequestId: pr.id ?? null };
  store.write(st);
  await odoo.executeKw("account.move", "message_post", [[moveId]], {
    body: `send21 pay link for ${req.body.fiatAmount} ${req.body.fiatCurrency}: ${link} (the customer signs and sends from their own wallet)`,
  });
  return link;
}

export async function createBillDraft(moveId: number, receiver: { address: string; network: EvmNetwork; currency: Token }, { odoo, store, config, fetchImpl = fetch }: Deps) {
  const move = await readMove(odoo, moveId);
  if (move.move_type !== "in_invoice" || move.state !== "posted") throw new Error(`${move.name} is not a posted vendor bill`);
  const req = buildBillDraft({ id: moveId, name: move.name, amount_residual: move.amount_residual, currency: move.currency }, receiver);
  const draft = await send21Post(fetchImpl, config.send21ApiKey, "drafts", req);
  const s = store.read();
  s.bills[draft.id] = { moveId, name: move.name, amount: req.body.fiatAmount, currency: req.body.fiatCurrency, partnerId: move.partner_id?.[0] ?? null };
  store.write(s);
  return { draftId: draft.id, paymentUri: draft.paymentUri ?? null };
}

/** What the confirmation refers to: a customer invoice (pay link) or a vendor bill (draft). */
function target(data: Record<string, any>, store: Store) {
  const moveId = moveIdFromOrder(data.orderId);
  if (moveId) return { kind: "invoice" as const, moveId };
  const bill = store.read().bills[data.draftId];
  return bill ? { kind: "bill" as const, moveId: bill.moveId as number, bill } : null;
}

/** Write send21 data onto the statement line odoo-web3 imported for this tx, like its Monerium step. */
export async function enrich(data: Record<string, any>, { odoo, store, config }: Deps): Promise<"enriched" | "pending" | "skipped"> {
  const txHash = /^0x[0-9a-fA-F]{64}$/.test(String(data.txId)) ? String(data.txId).toLowerCase() : null;
  const t = target(data, store);
  if (!txHash || !t) return "skipped";
  const move = await readMove(odoo, t.moveId);

  const lines = await odoo.executeKw("account.bank.statement.line", "search_read", [[["journal_id", "=", config.journalId], ["unique_import_id", "ilike", txHash]]], {
    fields: ["id", "unique_import_id", "partner_id", "amount", "is_reconciled"],
  });
  const line = lines.find((l: any) => txHashFromImportId(l.unique_import_id) === txHash);
  if (!line) {
    const s = store.read();
    s.pending[txHash] = data; // the transfer is not synced yet; retried by enrichPending()
    store.write(s);
    return "pending";
  }
  if (line.partner_id) return "skipped"; // only enrich lines without a partner, as odoo-web3 does
  await odoo.executeKw("account.bank.statement.line", "write", [[line.id], {
    partner_id: move.partner_id?.[0] ?? false,
    payment_ref: move.name, // lets odoo-web3's "reference + amount" reconciliation match the move
    transaction_details: JSON.stringify({ source: "send21", draftId: data.draftId, paymentRequestId: data.paymentRequestId ?? null, orderId: data.orderId ?? null, quoteId: data.quoteId ?? null, fiatAmount: data.fiatAmount, fiatCurrency: data.fiatCurrency, conversionRate: data.conversionRate, rateSource: data.rateSource, sentAmount: data.sentAmount, sentCurrency: data.sentCurrency, network: data.network, confirmedAt: data.confirmedAt }),
  }]);
  const s = store.read();
  delete s.pending[txHash];
  store.write(s);
  return "enriched";
}

export async function enrichPending(deps: Deps) {
  const results: Record<string, string> = {};
  for (const [hash, data] of Object.entries(deps.store.read().pending)) results[hash] = await enrich(data, deps);
  return results;
}

/** POST /send21/webhook */
export async function handleWebhook({ headers, body }: { headers: Record<string, any>; body: Buffer }, deps: Deps) {
  const deliveryId = headers["x-send21-delivery"];
  if (!verifySignatureV2(body, headers["x-send21-signature-v2"], deliveryId, deps.config.send21WebhookSecret, deps.now)) {
    return { status: 401, body: "bad signature" };
  }
  // Retries reuse X-Send21-Delivery and send21 does not dedupe for you.
  if (deps.store.read().deliveries.includes(deliveryId)) return { status: 200, body: "already handled" };

  const { event, data = {} } = JSON.parse(body.toString("utf8"));
  let result = "ignored";
  if (event === "draft.confirmed") {
    const t = target(data, deps.store);
    if (t?.kind === "invoice") {
      // Compare with what the pay link asked for, not with today's residual (odoo-web3 may
      // already have reconciled the line).
      const link = deps.store.read().links[data.orderId];
      const exact =
        link &&
        (!data.paymentRequestId || !link.paymentRequestId || data.paymentRequestId === link.paymentRequestId) &&
        String(data.fiatCurrency).toUpperCase() === link.currency &&
        Math.round(Number(data.fiatAmount) * 100) === Math.round(Number(link.amount) * 100);
      result = exact ? await enrich(data, deps) : "review: not the pay link, amount or currency this adapter created";
    } else if (t?.kind === "bill") {
      const exact = Math.round(Number(data.fiatAmount) * 100) === Math.round(Number(t.bill.amount) * 100) && String(data.fiatCurrency).toUpperCase() === t.bill.currency;
      result = exact ? await enrich(data, deps) : "review: amount or currency differs from the bill draft";
    }
  } else if (["draft.amount_mismatch", "draft.mismatch_reminder", "draft.mismatch_unresolved"].includes(event)) {
    result = "review: a different amount arrived; accept or decline it in send21 (refunds are manual)";
  }
  const s = deps.store.read();
  s.deliveries = [...s.deliveries, deliveryId].slice(-5000); // recorded after acting
  deps.store.write(s);
  return { status: 200, body: JSON.stringify({ result }) };
}
