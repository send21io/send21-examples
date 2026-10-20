// send21 tools for the Vercel AI SDK.
// send21 prepares payment instructions. It never holds keys or funds, never signs
// and never broadcasts. A key with the drafts:write scope can create a pay link but
// cannot move money: the payer opens the link and signs in their own wallet.
import { tool } from "ai";
import { z } from "zod";

export type Send21Options = {
  /** Scoped send21 API key (https://send21.io/api-keys). Defaults to process.env.SEND21_API_KEY. */
  apiKey?: string;
  /** Defaults to https://send21.io */
  baseUrl?: string;
  /** Receiving options the agent may use. When set, the model cannot choose addresses. */
  receiveOptions?: PayOption[];
  fetch?: typeof fetch;
};

export type PayOption = { currency: string; network: string; address: string; method?: "MultiOutput" | "Lightning" };

// Supported asset/network pairs (USDT only on Solana and Ethereum, no ETH on Polygon).
const SUPPORTED: Record<string, string[]> = {
  Btc: ["Mainnet"],
  Usdc: ["Solana", "Ethereum", "Base", "Arbitrum", "Polygon"],
  Usdt: ["Solana", "Ethereum"],
  Eurc: ["Solana", "Ethereum", "Base"],
  Sol: ["Solana"],
  Eth: ["Ethereum", "Base", "Arbitrum"],
};

// send21 MCP 1.5.0: new accounts only use receiving addresses the owner approved,
// and an agent-created account creates nothing until the owner takes it over.
// https://send21.io/docs/mcp
export function explainSend21Error(text: string): string | null {
  if (text.includes("address_not_approved")) return "422 address_not_approved: this receiving address is not approved in your send21 account, so nothing was created. Approve it in send21 (signed in, with a passkey or authenticator code), or propose it with propose_receiving_address and have the owner approve it, then retry.";
  if (text.includes("owner_not_confirmed")) return "403 owner_not_confirmed: the owner has not taken over this agent-created send21 account yet, so nothing can be created. The owner opens the emailed link and sets up a passkey or password first.";
  return null;
}

export function checkOption(o: PayOption): string | null {
  const nets = SUPPORTED[o.currency];
  if (!nets) return `Unsupported currency ${o.currency}`;
  if (!nets.includes(o.network)) return `${o.currency} is not supported on ${o.network} (supported: ${nets.join(", ")})`;
  if (o.method === "Lightning" && o.currency !== "Btc") return "Lightning is only for Btc";
  return null;
}

const optionSchema = z.object({
  currency: z.enum(["Btc", "Usdc", "Usdt", "Eurc", "Sol", "Eth"]),
  network: z.enum(["Mainnet", "Solana", "Ethereum", "Base", "Arbitrum", "Polygon"]),
  address: z.string().min(1).describe("The RECEIVER's own address, or Lightning address name@wallet.com"),
  method: z.enum(["MultiOutput", "Lightning"]).optional(),
});

export function send21Tools(opts: Send21Options = {}) {
  const baseUrl = (opts.baseUrl ?? "https://send21.io").replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;

  async function call(path: string, init: RequestInit = {}) {
    const key = opts.apiKey ?? process.env.SEND21_API_KEY;
    if (!key) throw new Error("SEND21_API_KEY is not set. Create a scoped key at https://send21.io/api-keys");
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(explainSend21Error(text) ?? `send21 ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  }

  const createPayLink = tool({
    description:
      "Create a send21 pay link so a human can pay. You are the RECEIVER. Returns a link; the payer picks a currency, scans one QR and signs in their own wallet. This tool cannot move funds.",
    inputSchema: z.object({
      fiatAmount: z.number().positive(),
      fiatCurrency: z.string().length(3).describe("ISO 4217, e.g. EUR, USD, SEK"),
      orderId: z.string().optional().describe("Your reference, echoed in webhooks"),
      memo: z.string().max(500).optional(),
      declineNote: z.string().max(200).optional().describe('Shown as "If you don\'t pay:" on the pay page'),
      options: z.array(optionSchema).optional().describe("Ignored when the app fixed receiveOptions"),
    }),
    execute: async (input) => {
      const options = opts.receiveOptions ?? input.options;
      if (!options?.length) throw new Error("No receiving options. Configure receiveOptions or pass options.");
      for (const o of options) {
        const err = checkOption(o);
        if (err) throw new Error(err);
      }
      const idempotencyKey = crypto.randomUUID();
      const pr = await call("/api/v1/payment-requests", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          fiatAmount: input.fiatAmount,
          fiatCurrency: input.fiatCurrency.toUpperCase(),
          options,
          orderId: input.orderId ?? null,
          memo: input.memo ?? null,
          declineNote: input.declineNote ?? null,
          reuseOpenForOrder: input.orderId ? true : null,
        }),
      });
      return {
        paymentRequestId: pr.id,
        payLink: new URL(pr.payPath, baseUrl).toString(),
        status: pr.status,
        expiresAt: pr.expiresAt,
        note: "Send this link to the payer. They sign in their own wallet; nothing moves until they do.",
      };
    },
  });

  const getPayLinkStatus = tool({
    description: "Get the status of a send21 pay link (Open, Completed, Cancelled, Expired) and any unusual-payment notes.",
    inputSchema: z.object({ paymentRequestId: z.string().uuid() }),
    execute: async ({ paymentRequestId }) => {
      const pr = await call(`/api/v1/payment-requests/${encodeURIComponent(paymentRequestId)}`);
      return { status: pr.status, draftStatus: pr.draftStatus, expiresAt: pr.expiresAt, changeNotes: pr.changeNotes ?? [] };
    },
  });

  return { send21CreatePayLink: createPayLink, send21GetPayLinkStatus: getPayLinkStatus };
}
