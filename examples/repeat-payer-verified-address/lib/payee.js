// The approved payee: stored once, used for every monthly payment.
//
// Where the approved address lives:
//  1. send21's address book. An entry the account owner verified in the send21 app
//     (passkey or authenticator code) has `verifiedAt` set. No API key can verify one.
//     With the receiving-address policy `ApprovedOnly`, API keys can only pay verified addresses.
//  2. If the key cannot read the address book, or the address is not verified there yet,
//     this example falls back to payee.json, the file you reviewed and saved yourself.
//     That is a local config file, not a send21 approval. The output says which source was used.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Send21Error } from "./send21.js";

// Which assets each network carries (https://send21.io/docs/currencies).
// USDT is on Solana and Ethereum only. Never USDT or BTC on Base.
const SUPPORTED = {
  Usdc: ["Solana", "Ethereum", "Base", "Arbitrum", "Polygon"],
  Usdt: ["Solana", "Ethereum"],
  Eurc: ["Solana", "Ethereum", "Base"],
};

export function loadPayee(dir = process.cwd()) {
  const file = [process.env.PAYEE_FILE, "payee.local.json", "payee.json"].filter(Boolean).map((f) => resolve(dir, f)).find((f) => existsSync(f));
  if (!file) throw new Error("No payee.json found.");
  const payee = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["id", "label", "network", "currency", "address", "fiatCurrency", "fiatAmount"]) {
    if (payee[k] === undefined || payee[k] === "") throw new Error(`payee.json: "${k}" is missing`);
  }
  if (/^REPLACE/.test(payee.address)) throw new Error("payee.json: put the payee's real receiving address in \"address\" (copy it from the invoice or contract they sent you, never from wallet history).");
  if (!SUPPORTED[payee.currency]?.includes(payee.network)) {
    throw new Error(`payee.json: ${payee.currency} on ${payee.network} is not offered. ${payee.currency} runs on: ${(SUPPORTED[payee.currency] ?? []).join(", ") || "see https://send21.io/docs/currencies"}`);
  }
  return { ...payee, file, fileName: file.split(/[\\/]/).pop() };
}

// Look the address up in the send21 address book (scope addressbook:read).
export async function resolveApproval(api, payee) {
  const local = payee.fileName ?? "payee.json";
  try {
    const book = await api.get("/address-book");
    const entry = (book ?? []).find((e) => e.address === payee.address && e.network === payee.network);
    if (entry?.verifiedAt) {
      return { source: "send21-address-book", verified: true, entryId: entry.id, verifiedAt: entry.verifiedAt, note: "Verified by the account owner in the send21 address book." };
    }
    if (entry) {
      return { source: local, verified: false, entryId: entry.id, note: `Saved in the send21 address book but not verified yet. The owner verifies it in the send21 app. Using ${local} for now.` };
    }
    return { source: local, verified: false, note: `Not in the send21 address book. Using the address saved in ${local}.` };
  } catch (err) {
    if (err instanceof Send21Error && (err.status === 401 || err.status === 403)) {
      return { source: local, verified: false, note: `This key has no addressbook:read scope. Using the address saved in ${local}.` };
    }
    throw err;
  }
}
