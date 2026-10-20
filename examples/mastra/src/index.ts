// A minimal Mastra agent that gets paid through send21.
//
// The agent connects to the remote send21 MCP server (https://send21.io/mcp) with Mastra's
// MCPClient, creates a pay link and reads its status. Receiving addresses are fixed here in
// code; the model only picks the amount, currency and order reference. The agent never holds
// keys: send21 never signs or broadcasts, and the payer signs in their own wallet.
//
//   npm run dry-run                 no keys needed: lists the live tools and checks the arguments
//   npm start -- --tools-only       SEND21_API_KEY: create + read status without an LLM
//   npm start                       SEND21_API_KEY + model key: the agent does it from a prompt

import { randomUUID } from "node:crypto";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { MCPClient } from "@mastra/mcp";
import { z } from "zod";

const MCP_URL = "https://send21.io/mcp";
const SITE = "https://send21.io";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const toolsOnly = args.includes("--tools-only");
const apiKey = process.env.SEND21_API_KEY;

// --- 1. Fixed receive options. These come from your config, never from the model. ---------
type PayOption = { currency: string; network: string; address: string; method?: "MultiOutput" | "Lightning" };

function receiveOptions(): PayOption[] {
  const opts: PayOption[] = [];
  const sol = process.env.MY_SOLANA_ADDRESS;
  const base = process.env.MY_BASE_ADDRESS;
  const ln = process.env.MY_LIGHTNING_ADDRESS;
  if (sol) opts.push({ currency: "Usdc", network: "Solana", address: sol });
  if (base) opts.push({ currency: "Usdc", network: "Base", address: base });
  if (ln) opts.push({ currency: "Btc", network: "Mainnet", address: ln, method: "Lightning" });
  if (opts.length === 0) {
    if (!dryRun) throw new Error("Set at least one of MY_SOLANA_ADDRESS, MY_BASE_ADDRESS, MY_LIGHTNING_ADDRESS");
    opts.push({ currency: "Usdc", network: "Solana", address: "<your-solana-address>" });
  }
  return opts;
}

// Supported pairs (USDT only on Solana and Ethereum). Checked before anything is sent.
const SUPPORTED: Record<string, string[]> = {
  Btc: ["Mainnet"],
  Usdc: ["Solana", "Ethereum", "Base", "Arbitrum", "Polygon"],
  Usdt: ["Solana", "Ethereum"],
  Eurc: ["Solana", "Ethereum", "Base"],
  Sol: ["Solana"],
  Eth: ["Ethereum", "Base", "Arbitrum"],
};
function checkOptions(opts: PayOption[]): void {
  for (const o of opts) {
    if (!SUPPORTED[o.currency]?.includes(o.network)) throw new Error(`${o.currency} on ${o.network} is not supported`);
    if (o.method === "Lightning" && o.currency !== "Btc") throw new Error("Lightning is only for Btc");
  }
}

// --- 2. Connect to the remote send21 MCP server. -----------------------------------------
const mcp = new MCPClient({
  id: "send21-mastra-example",
  clientInfo: { name: "send21-mastra-example", version: "1.0.0" },
  servers: {
    send21: {
      url: new URL(MCP_URL),
      allowedHosts: ["send21.io"],
      ...(apiKey ? { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } } : {}),
    },
  },
});

// send21 MCP 1.5.0: new accounts only use receiving addresses the owner approved,
// and an agent-created account creates nothing until the owner takes it over.
// https://send21.io/docs/mcp
function explainSend21Error(text: string): string | null {
  if (text.includes("address_not_approved")) return "422 address_not_approved: this receiving address is not approved in your send21 account, so nothing was created. Approve it in send21 (signed in, with a passkey or authenticator code), or propose it with propose_receiving_address and have the owner approve it, then retry.";
  if (text.includes("owner_not_confirmed")) return "403 owner_not_confirmed: the owner has not taken over this agent-created send21 account yet, so nothing can be created. The owner opens the emailed link and sets up a passkey or password first.";
  return null;
}

// MCP results arrive as structured content or as JSON text; normalise to an object.
function unwrap(result: unknown): any {
  const r = result as any;
  if (r && typeof r === "object" && Array.isArray(r.content)) {
    if (r.structuredContent) return r.structuredContent;
    const text = r.content.find((c: any) => c.type === "text")?.text;
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return r;
}

async function main(): Promise<void> {
  const options = receiveOptions();
  checkOptions(options);

  if (dryRun) {
    // No key needed: tools/list is public. Nothing is created.
    const defs = (await mcp.listToolDefinitions()) as Record<string, Record<string, { inputSchema?: any }>>;
    const tools = defs.send21 ?? {};
    console.log(`Connected to ${MCP_URL}: ${Object.keys(tools).length} tools`);
    for (const name of ["create_payment_request", "get_payment_request"]) {
      if (!tools[name]) throw new Error(`Tool ${name} not offered by the server`);
    }
    const schema = tools.create_payment_request.inputSchema;
    const planned = { fiatCurrency: "EUR", fiatAmount: 25, options, orderId: "inv-1042", reuseOpenForOrder: true, idempotencyKey: randomUUID() };
    const missing = (schema?.required ?? []).filter((k: string) => !(k in planned));
    if (missing.length) throw new Error(`Missing required arguments: ${missing.join(", ")}`);
    const unknown = Object.keys(planned).filter((k) => !(k in (schema?.properties ?? {})));
    if (unknown.length) throw new Error(`Arguments not in the live schema: ${unknown.join(", ")}`);
    console.log("Dry run OK. create_payment_request would be called with:");
    console.log(JSON.stringify(planned, null, 2));
    return;
  }

  if (!apiKey) throw new Error("Set SEND21_API_KEY (scopes drafts:write, drafts:read; https://send21.io/api-keys), or use --dry-run");

  const mcpTools = await mcp.listTools(); // namespaced: send21_<tool>
  const createPR = mcpTools["send21_create_payment_request"];
  const getPR = mcpTools["send21_get_payment_request"];
  if (!createPR?.execute || !getPR?.execute) throw new Error("send21 MCP tools not available");

  // --- 3. The two tools the agent gets. Addresses are injected here, not chosen by the model.
  const createPayLink = createTool({
    id: "create_pay_link",
    description:
      "Create a send21 pay link so a human can pay. Returns the link and its id. The payer picks a currency, " +
      "scans one QR code and signs in their own wallet. This tool cannot move funds.",
    inputSchema: z.object({
      fiatAmount: z.number().positive(),
      fiatCurrency: z.string().length(3).describe("ISO 4217 code, e.g. EUR"),
      orderId: z.string().optional(),
      memo: z.string().max(500).optional(),
    }),
    execute: async ({ fiatAmount, fiatCurrency, orderId, memo }, ctx) => {
      const pr = unwrap(
        await createPR.execute!(
          {
            fiatAmount,
            fiatCurrency: fiatCurrency.toUpperCase(),
            options, // fixed in code
            orderId: orderId ?? null,
            memo: memo ?? null,
            reuseOpenForOrder: orderId ? true : null, // one open link per order on retries
            idempotencyKey: randomUUID(),
          },
          ctx,
        ),
      );
      if (!pr?.payPath) throw new Error(explainSend21Error(JSON.stringify(pr)) ?? `create_payment_request failed: ${JSON.stringify(pr).slice(0, 300)}`);
      return { paymentRequestId: pr.id, payLink: new URL(pr.payPath, SITE).toString(), status: pr.status, expiresAt: pr.expiresAt };
    },
  });

  const getPayLinkStatus = createTool({
    id: "get_pay_link_status",
    description: "Read the status of a send21 pay link: Open, Completed, Cancelled or Expired.",
    inputSchema: z.object({ paymentRequestId: z.string() }),
    execute: async ({ paymentRequestId }, ctx) => {
      const pr = unwrap(await getPR.execute!({ paymentRequestId }, ctx));
      return { status: pr.status, draftStatus: pr.draftStatus ?? null, expiresAt: pr.expiresAt, changeNotes: pr.changeNotes ?? [] };
    },
  });

  if (toolsOnly) {
    // Same tools, called directly without a model.
    const ctx = {} as Parameters<NonNullable<typeof createPayLink.execute>>[1];
    const link = (await createPayLink.execute!({ fiatAmount: 25, fiatCurrency: "EUR", orderId: `mastra-${Date.now()}` }, ctx)) as any;
    console.log("Created:", link);
    console.log("Status:", await getPayLinkStatus.execute!({ paymentRequestId: link.paymentRequestId }, ctx));
    return;
  }

  // --- 4. The agent. Any Mastra model id works; set the matching provider key (e.g. OPENAI_API_KEY).
  const agent = new Agent({
    id: "send21-billing-agent",
    name: "send21 billing agent",
    instructions:
      "You create pay links with send21 and report their status. You never ask for or handle private keys or " +
      "seed phrases, and you cannot pay or sign: the payer signs in their own wallet. Give the user the pay link.",
    model: process.env.MODEL ?? "openai/gpt-5-mini",
    tools: { createPayLink, getPayLinkStatus },
  });

  const prompt = args.filter((a) => !a.startsWith("--")).join(" ") ||
    "Create a pay link for 25 EUR for order inv-1042, then check its status.";
  const res = await agent.generate(prompt, { maxSteps: 4 });
  console.log(res.text);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => mcp.disconnect());
