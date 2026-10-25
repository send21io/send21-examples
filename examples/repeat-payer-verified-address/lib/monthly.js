// Create this month's payment draft from the stored payee, then check the address
// in every place it appears against the approved one.
import { chunk, compareAddresses } from "./address.js";

export function monthKey(date = new Date()) {
  // PAYMENT_MONTH=2026-11 lets you prepare a month ahead (or re-run a demo).
  return process.env.PAYMENT_MONTH || date.toISOString().slice(0, 7); // "2026-10"
}

export function draftBody(payee, month) {
  return {
    receiverAddress: payee.address, // always from the stored payee, never pasted
    network: payee.network,
    currency: payee.currency,
    paymentMethod: "MultiOutput",
    singleOutput: true, // one QR payment from any wallet; the send21 fee is billed to the account
    fiatCurrency: payee.fiatCurrency,
    fiatAmount: payee.fiatAmount,
    memo: `${payee.label}, ${month}`,
  };
}

export async function createMonthlyDraft(api, payee, { month = monthKey() } = {}) {
  // Same key for the same payee and month: a double click or a retry returns the same draft.
  const idempotencyKey = `monthly-${payee.id}-${month}`;
  const draft = await api.post("/drafts", draftBody(payee, month), { idempotencyKey });
  if (draft.status === "Cancelled" || draft.status === "Expired") {
    throw new Error(`This month's draft (${draft.id}) is ${draft.status.toLowerCase()}. Set PAYMENT_MONTH (for example ${nextMonth(month)}) to prepare a new one.`);
  }
  const template = await api.get(`/drafts/${draft.id}/tx-template`);
  return { idempotencyKey, draft, template, checks: addressChecks(payee.address, draft, template) };
}

// The address must match exactly in the draft, in the wallet instructions and in the QR link.
export function addressChecks(approved, draft, template) {
  const outputs = (template?.outputs ?? []).map((o) => o.address).filter(Boolean);
  const receiverOutput = outputs.find((a) => a === approved) ?? outputs[0];
  const uriAddress = /^[a-z]+:([^?@]+)/i.exec(draft.paymentUri ?? "")?.[1];
  const checks = [
    { where: "draft.receiverAddress", value: draft.receiverAddress, ...compareAddresses(approved, draft.receiverAddress) },
    { where: "tx-template output", value: receiverOutput, ...compareAddresses(approved, receiverOutput) },
  ];
  if (uriAddress) checks.push({ where: "paymentUri (QR link)", value: uriAddress, ...compareAddresses(approved, uriAddress) });
  return { allMatch: checks.every((c) => c.match), checks, approvedChunks: chunk(approved) };
}

// A monthly recurring template (POST /recurring-templates, interval Monthly).
// send21 creates the draft each month from the stored address; the payer still signs each one.
export async function ensureMonthlyTemplate(api, payee, { firstRunAt } = {}) {
  const name = `monthly ${payee.id}`;
  const existing = (await api.get("/recurring-templates")).find((t) => t.name === name);
  const template = existing ?? (await api.post("/recurring-templates", {
    name,
    interval: "Monthly",
    firstRunAt: firstRunAt ?? firstOfNextMonth(),
    draft: draftBody(payee, "monthly"),
  }, { idempotencyKey: `template-${payee.id}` }));
  return { reused: Boolean(existing), template, check: compareAddresses(payee.address, template.draft?.receiverAddress) };
}

function firstOfNextMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 8, 0, 0)).toISOString();
}

function nextMonth(m) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
}
