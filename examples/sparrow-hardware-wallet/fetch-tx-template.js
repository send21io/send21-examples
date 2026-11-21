#!/usr/bin/env node
/**
 * Fetch GET /api/v1/drafts/{id}/tx-template and write the Sparrow/Electrum
 * pay-to-many CSV, plus the bitcoin-cli walletcreatefundedpsbt example.
 *
 * A draft with paymentMethod MultiOutput and singleOutput=false puts the
 * send21 fee in a separate output, which is what PSBT wallets expect.
 * Nothing moves until a person signs and sends from their own wallet
 * (Sparrow, typically with a hardware wallet such as Coldcard).
 */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const API = "https://send21.io/api/v1";

export function parseArgs(argv, env = process.env) {
  const args = { draftId: env.SEND21_DRAFT_ID, out: "pay-to-many.csv", apiKey: env.SEND21_API_KEY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--draft" || a === "--draft-id") args.draftId = argv[++i];
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--api-key") args.apiKey = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("-") && !args.draftId) args.draftId = a;
  }
  return args;
}

export function csvFileName(outPath) {
  return resolve(outPath);
}

/**
 * Prefer the API's payToManyCsv when present. If a caller only has outputs,
 * build the same two-column CSV Sparrow and Electrum expect: address,amount
 * with BTC amounts (not sats).
 */
export function payToManyCsvFrom(template) {
  if (typeof template?.payToManyCsv === "string" && template.payToManyCsv.trim()) {
    return template.payToManyCsv.endsWith("\n") ? template.payToManyCsv : `${template.payToManyCsv}\n`;
  }
  const rows = (template?.outputs ?? []).map((output) => {
    const address = output.address;
    const amount = output.amountBtc ?? satsToBtc(output.amountSats);
    if (!address || amount === undefined || amount === null) {
      throw new Error("tx-template output is missing address or amount");
    }
    return `${address},${amount}`;
  });
  return rows.join("\n") + (rows.length ? "\n" : "");
}

export function satsToBtc(sats) {
  if (sats === undefined || sats === null) return undefined;
  const n = BigInt(sats);
  const whole = n / 100000000n;
  const frac = (n % 100000000n).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

export function summarizeOutputs(template) {
  return (template?.outputs ?? []).map((output) => ({
    address: output.address,
    amountBtc: output.amountBtc ?? satsToBtc(output.amountSats),
    amountSats: output.amountSats,
    purpose: output.purpose ?? null,
  }));
}

async function send21(path, apiKey) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`send21 API ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.draftId) {
    console.log(`Usage: node fetch-tx-template.js --draft <draft-id> [--out pay-to-many.csv]

Environment: SEND21_API_KEY (drafts:read), optional SEND21_DRAFT_ID.

Create the draft first with paymentMethod MultiOutput and singleOutput=false,
on Bitcoin mainnet, then pass its id. Account keys use the live networks;
https://send21.io/demo is testnet only.
`);
    process.exit(args.help ? 0 : 2);
  }
  if (!args.apiKey) throw new Error("Set SEND21_API_KEY (drafts:read). The key cannot move funds.");

  const template = await send21(`/drafts/${args.draftId}/tx-template`, args.apiKey);
  const csv = payToManyCsvFrom(template);
  const out = csvFileName(args.out);
  await writeFile(out, csv, "utf8");

  console.log("Draft:", args.draftId);
  console.log("Outputs:");
  for (const row of summarizeOutputs(template)) {
    console.log(`  ${row.purpose ?? "output"}  ${row.amountBtc} BTC  ${row.address}`);
  }
  if (template.walletRpcExample) {
    console.log("\nbitcoin-cli example (walletcreatefundedpsbt):");
    console.log(template.walletRpcExample);
  }
  if (template.note) console.log("\nNote:", template.note);
  console.log(`\nWrote Sparrow pay-to-many CSV: ${out}`);
  console.log(
    "Open Sparrow, start a transaction, use the pay-to-many / CSV import, check every address and amount, then sign on your hardware wallet and broadcast. Nothing moves until you do."
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
