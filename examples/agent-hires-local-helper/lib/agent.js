// What the agent does when a task is reported done. It only drafts; it never pays.
//
//  1. get_account_status      : which receiving-address policy the account uses
//  2. list_address_book       : is the helper's address one the owner approved?
//  3. create_payment_request  : a pay link to that address, with orderId and
//                               reuseOpenForOrder: true, so a repeated request returns
//                               the open link instead of a second one
//
// The owner opens the link and signs in their own wallet. No key can move funds.
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
  return { ...cfg, fileName: file.split(/[\\/]/).pop(), orderId: `helper-task-${cfg.task.id}` };
}

export async function draftPaymentForDoneTask(mcp, cfg, { idempotencyKey } = {}) {
  const steps = [];
  const { helper, task, orderId } = cfg;

  const status = await mcp.callTool("get_account_status");
  steps.push({ tool: "get_account_status", result: `receiving-address policy ${status.receivingAddressPolicy}, ${status.approvedReceivingAddresses} approved receiving address(es)` });

  let approved = null;
  try {
    const book = await mcp.callTool("list_address_book");
    const entry = (book ?? []).find((e) => e.address === helper.address && e.network === helper.network);
    approved = Boolean(entry?.verifiedAt);
    steps.push({ tool: "list_address_book", result: approved ? "helper address is approved by the owner" : entry ? "helper address is saved but not approved yet" : "helper address is not in the send21 address book" });
  } catch (e) {
    steps.push({ tool: "list_address_book", result: "not readable with this key (needs addressbook:read)" });
  }
  if (status.receivingAddressPolicy === "ApprovedOnly" && !approved) {
    // The agent cannot approve addresses. It stops and tells the owner.
    return { stopped: true, steps, reason: "The helper's address is not approved in send21 yet. Approve it in the send21 app (passkey or authenticator code), then mark the task done again." };
  }

  const args = {
    fiatCurrency: task.fiatCurrency,
    fiatAmount: task.fiatAmount,
    options: [{ currency: helper.currency, network: helper.network, address: helper.address }],
    orderId,
    memo: `${task.title}: done`,
    reuseOpenForOrder: true, // a repeated request for this orderId returns the open link
  };
  if (idempotencyKey) args.idempotencyKey = idempotencyKey;
  const pr = await mcp.callTool("create_payment_request", args);
  steps.push({ tool: "create_payment_request", result: `pay link ${pr.id} for orderId ${pr.orderId}, status ${pr.status}` });

  const option = pr.options?.[0];
  return {
    stopped: false,
    steps,
    approvedInSend21: approved,
    paymentRequest: { id: pr.id, orderId: pr.orderId, status: pr.status, fiatCurrency: pr.fiatCurrency, fiatAmount: pr.fiatAmount, memo: pr.memo, expiresAt: pr.expiresAt, createdAt: pr.createdAt, option },
    payUrl: `https://send21.io${pr.payPath}`,
    addressCheck: compareAddresses(helper.address, option?.address),
  };
}

export async function readPaymentStatus(mcp, paymentRequestId) {
  const pr = await mcp.callTool("get_payment_request", { paymentRequestId });
  return { status: pr.status, draftStatus: pr.draftStatus ?? null, activeDraftId: pr.activeDraftId ?? null };
}
