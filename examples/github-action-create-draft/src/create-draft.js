#!/usr/bin/env node
/**
 * Create a send21 draft and optionally comment its status on a GitHub issue.
 * The API key cannot move funds; a person signs and sends from their own wallet.
 */

import { appendFileSync, readFileSync } from "node:fs";

const API = "https://send21.io/api/v1";
const SITE = "https://send21.io";

export function draftBody(input) {
  const body = {
    receiverAddress: required(input.receiverAddress, "receiver-address"),
    network: input.network || "Solana",
    currency: input.currency || "Usdc",
    paymentMethod: input.paymentMethod || "MultiOutput",
  };
  if (input.amountSats) body.amountSats = Number(input.amountSats);
  else if (input.fiatAmount) {
    body.fiatCurrency = input.fiatCurrency || "EUR";
    body.fiatAmount = Number(input.fiatAmount);
  } else {
    throw new Error("Set fiat-amount or amount-sats");
  }
  if (input.memo) body.memo = input.memo;
  if (input.expiryHours) body.expiryHours = Number(input.expiryHours);
  if (input.singleOutput !== undefined && input.singleOutput !== "") {
    body.singleOutput = String(input.singleOutput).toLowerCase() !== "false";
  } else {
    body.singleOutput = true;
  }
  return body;
}

export function defaultIdempotencyKey({ owner, repo, issueNumber }) {
  return `send21-draft-${owner}/${repo}#${issueNumber}`;
}

export function statusComment({ draft, status, repository }) {
  const st = status?.status ?? draft.status ?? "AwaitingPayment";
  const lines = [
    "A send21 payment draft is ready. The workflow only prepared it: no API key can move funds.",
    "A person signs and sends this payment from their own wallet. send21 never holds the funds.",
    "",
    `- Draft: \`${draft.id}\``,
    `- Status: **${st}**`,
  ];
  if (draft.fiatCurrency && draft.fiatAmount !== undefined) {
    lines.push(`- Amount: ${draft.fiatAmount} ${draft.fiatCurrency}`);
  } else if (draft.amountSats !== undefined) {
    lines.push(`- Amount (base units): ${draft.amountSats} ${draft.currency ?? ""}`.trim());
  }
  lines.push(`- To: \`${draft.receiverAddress}\` on ${draft.network} (${draft.currency})`);
  if (draft.paymentUri) lines.push(`- Wallet link: ${draft.paymentUri}`);
  if (draft.expiresAt) lines.push(`- Expires: ${draft.expiresAt}`);
  if (status?.confirmedAt) lines.push(`- Confirmed at: ${status.confirmedAt}`);
  if (status?.paidTxId) lines.push(`- Transaction: \`${status.paidTxId}\``);
  lines.push("", `Track it at ${SITE} or with \`GET /api/v1/drafts/${draft.id}/status\`.`);
  if (repository) lines.push("", `_Created from ${repository}._`);
  return lines.join("\n");
}

function required(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function issueNumberFromEvent(event) {
  return event?.issue?.number ?? event?.pull_request?.number ?? event?.number ?? undefined;
}

async function send21(method, path, { apiKey, body, idempotencyKey }) {
  const headers = {
    Authorization: `Bearer ${apiKey.replace(/^Bearer\s+/i, "")}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`send21 API ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function commentOnIssue({ apiUrl, token, repository, issueNumber, body }) {
  const res = await fetch(`${apiUrl}/repos/${repository}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${text}`);
  return JSON.parse(text);
}

export async function run(env = process.env) {
  const apiKey = required(env.SEND21_API_KEY, "api-key / SEND21_API_KEY");
  const repository = env.GITHUB_REPOSITORY || "";
  const [owner, repo] = repository.split("/");
  let event = {};
  if (env.GITHUB_EVENT_PATH) {
    try {
      event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    } catch {
      event = {};
    }
  }
  const issueNumber = env.INPUT_ISSUE_NUMBER || issueNumberFromEvent(event);
  const idempotencyKey =
    env.INPUT_IDEMPOTENCY_KEY ||
    (issueNumber && owner && repo
      ? defaultIdempotencyKey({ owner, repo, issueNumber })
      : `send21-draft-${Date.now()}`);

  const body = draftBody({
    receiverAddress: env.INPUT_RECEIVER_ADDRESS,
    network: env.INPUT_NETWORK,
    currency: env.INPUT_CURRENCY,
    paymentMethod: env.INPUT_PAYMENT_METHOD,
    fiatCurrency: env.INPUT_FIAT_CURRENCY,
    fiatAmount: env.INPUT_FIAT_AMOUNT,
    amountSats: env.INPUT_AMOUNT_SATS,
    memo: env.INPUT_MEMO,
    expiryHours: env.INPUT_EXPIRY_HOURS,
    singleOutput: env.INPUT_SINGLE_OUTPUT,
  });

  const draft = await send21("POST", "/drafts", { apiKey, body, idempotencyKey });
  const status = await send21("GET", `/drafts/${draft.id}/status`, { apiKey });

  let commentUrl = "";
  const shouldComment = String(env.INPUT_COMMENT ?? "true").toLowerCase() !== "false";
  if (shouldComment) {
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required to comment");
    if (!repository || !issueNumber) {
      throw new Error("Set issue-number (or run this on an issue / pull_request event) to comment");
    }
    const posted = await commentOnIssue({
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
      token: env.GITHUB_TOKEN,
      repository,
      issueNumber,
      body: statusComment({ draft, status, repository }),
    });
    commentUrl = posted.html_url || "";
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      [
        `draft-id=${draft.id ?? ""}`,
        `status=${status.status ?? draft.status ?? ""}`,
        `payment-uri=${draft.paymentUri ?? ""}`,
        `comment-url=${commentUrl}`,
        "",
      ].join("\n")
    );
  }

  return { draft, status, commentUrl };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run().then((result) => {
    console.log(
      JSON.stringify(
        {
          draftId: result.draft.id,
          status: result.status.status,
          paymentUri: result.draft.paymentUri,
          commentUrl: result.commentUrl,
        },
        null,
        2
      )
    );
  }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
