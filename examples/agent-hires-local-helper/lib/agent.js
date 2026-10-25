// What the agent does when a task is reported done. It only drafts; it never pays.
//
//  1. get_account_status (MCP) : which receiving-address policy the account uses
//  2. list_address_book  (MCP) : is the helper's address one the owner approved?
//  3. POST /api/v1/drafts      : a payment DRAFT to that address, with
//                                Idempotency-Key "helper-task-<task id>", so a repeated
//                                request for the same task returns the same draft
//
// Why a draft and not a pay link: send21 says "Pay links need the owner's own approved
// receiving addresses; drafts may pay any approved address." The helper's address is not
// the owner's own, so on default (ApprovedOnly) accounts paying it takes a draft.
//
// Why REST for step 3: the MCP create_draft tool makes a draft with the send21 fee as a
// separate output (for batching wallets). POST /drafts with singleOutput: true makes one
// QR payment any wallet can pay, with the fee billed to the account.
//
// The owner opens the payment in their own wallet and signs. No key can move funds.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { compareAddresses } from "./address.js";

const SUPPORTED = { Usdc: ["Solana", "Ethereum", "Base", "Arbitrum", "Polygon"], Usdt: ["Solana", "Ethereum"], Eurc: ["Solana", "Ethereum", "Base"] };

export function loadConfig(dir = process.cwd()) {
  const file = [process.env.HELPER_FILE, "helper.local.json", "helper.json"].filter(Boolean).map((f) => resolve(dir, f)).find((f) => existsSync(f));
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  const h = cfg.helper;
  if (!h?.address || /^REPLACE/.test(h.address)) throw new Error("helper.json: put your helper's receiving address in helper.address (one they gave you directly).");
  if (!SUPPORTED[h.currency]?.includes(h.network)) throw new Error(`helper.json: ${h.currency} on ${h.network} is not offered (USDT is on Solana and Ethereum only).`);
  // Drafts have no orderId field. The task id goes into the Idempotency-Key and the memo.
  return { ...cfg, fileName: file.split(/[\\/]/).pop(), idempotencyKey: `helper-task-${cfg.task.id}` };
}

export function draftBody(cfg) {
  const { helper, task } = cfg;
  return {
    receiverAddress: helper.address, // from the saved helper record, never from a message
    network: helper.network,
    currency: helper.currency,
    paymentMethod: "MultiOutput",
    singleOutput: true,
    fiatCurrency: task.fiatCurrency,
    fiatAmount: task.fiatAmount,
    memo: `${task.title}: done (task ${task.id})`,
  };
}

export async function draftPaymentForDoneTask({ mcp, api }, cfg) {
  const steps = [];
  const { helper } = cfg;

  const status = await mcp.callTool("get_account_status");
  steps.push({ tool: "get_account_status", result: `receiving-address policy ${status.receivingAddressPolicy}, ${status.approvedPayingAddresses ?? 0} approved paying address(es)` });

  let approved = false;
  try {
    const book = await mcp.callTool("list_address_book");
    const entry = (book ?? []).find((e) => e.address === helper.address && e.network === helper.network);
    approved = Boolean(entry?.verifiedAt);
    steps.push({ tool: "list_address_book", result: approved ? "helper address is approved by the owner" : entry ? "helper address is saved but not approved yet" : "helper address is not in the send21 address book" });
  } catch {
    steps.push({ tool: "list_address_book", result: "not readable with this key (needs addressbook:read)" });
  }
  if (status.receivingAddressPolicy === "ApprovedOnly" && !approved) {
    // The agent cannot approve addresses. It stops, tells the owner and creates nothing.
    return { stopped: true, steps, reason: "The helper's address is not approved in send21 yet. Approve it in the send21 app (passkey or authenticator code), then mark the task done again." };
  }

  let draft = await api.post("/drafts", draftBody(cfg), { idempotencyKey: cfg.idempotencyKey });
  steps.push({ tool: "POST /drafts", result: `draft ${draft.id}, Idempotency-Key ${cfg.idempotencyKey}, status ${draft.status}` });

  // A fiat price is locked for 15 minutes. Within the draft's life, re-quote instead of a twin.
  if (draft.status === "Expired" && new Date(draft.expiresAt) > new Date()) {
    draft = await api.post(`/drafts/${draft.id}/requote`);
    steps.push({ tool: "POST /drafts/{id}/requote", result: `price lock renewed until ${draft.quote?.lockedUntil ?? draft.quote?.expiresAt}` });
  }
  if (draft.status !== "AwaitingPayment" && draft.status !== "Seen" && draft.status !== "Confirmed") {
    return { stopped: true, steps, reason: `The draft for this task is ${draft.status.toLowerCase()}. Give the task a new id in helper.json to draft a new payment.` };
  }

  return {
    stopped: false,
    steps,
    approvedInSend21: approved,
    draft: pick(draft),
    addressCheck: compareAddresses(helper.address, draft.receiverAddress),
  };
}

function pick(d) {
  return {
    id: d.id, status: d.status, network: d.network, currency: d.currency, receiverAddress: d.receiverAddress,
    amountBaseUnits: d.amountBaseUnits, fiatCurrency: d.fiatCurrency, fiatAmount: d.fiatAmount, memo: d.memo,
    paymentUri: d.paymentUri, expiresAt: d.expiresAt, lockedUntil: d.quote?.lockedUntil ?? d.quote?.expiresAt ?? null,
  };
}

export async function readDraftStatus(mcp, draftId) {
  const s = await mcp.callTool("get_draft_status", { draftId });
  return { status: s.status, paidTxId: s.paidTxId ?? null, confirmedAt: s.confirmedAt ?? null, reviewState: s.reviewState ?? null };
}

// Mark paid only for this task's draft, asset, network and billed amount.
// draft.confirmed carries draftId, sentCurrency, network and amountSats (base units);
// orderId is only set for pay-link payments, so a draft is matched by its id.
export function confirmsDraft(event, data, draft) {
  return event === "draft.confirmed" && Boolean(draft) && data?.draftId === draft.id
    && String(data.sentCurrency).toLowerCase() === String(draft.currency).toLowerCase()
    && data.network === draft.network
    && Number(data.amountSats) === Number(draft.amountBaseUnits);
}
