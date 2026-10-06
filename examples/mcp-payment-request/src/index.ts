// Agent-side example: create a send21 payment request (pay link) through the
// send21 MCP server. The agent only prepares the payment instructions. The
// payer opens the link and signs in their own wallet. send21 never holds keys
// or funds, never signs and never broadcasts.
//
// Usage:
//   npm start -- <amount> <fiatCurrency> [--option Currency:Network:Address]... [--memo text] [--order-id id] [--dry-run]
//
// Example:
//   npm start -- 25 EUR --option Usdc:Solana:<your-solana-address> --memo "Invoice 1042"

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Load the .env file in the repo root if it exists. Real environment variables win.
try {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env", import.meta.url)));
} catch {
  // No .env file, rely on the environment.
}

const MCP_URL = process.env.SEND21_MCP_URL ?? "https://send21.io/mcp";
const SITE_URL = "https://send21.io";
const TOOL = "create_payment_request";

type PayOption = { currency: string; network: string; address: string };

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    "Usage: npm start -- <amount> <fiatCurrency> [--option Currency:Network:Address]... [--memo text] [--order-id id] [--dry-run]\n" +
      "Options can also come from SEND21_PAY_OPTIONS (comma separated, same Currency:Network:Address format).",
  );
  process.exit(1);
}

function parseOption(raw: string): PayOption {
  const [currency, network, ...rest] = raw.trim().split(":");
  const address = rest.join(":");
  if (!currency || !network || !address) usage(`bad option "${raw}", expected Currency:Network:Address`);
  return { currency, network, address };
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const options: PayOption[] = [];
  let memo: string | null = null;
  let orderId: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--option") options.push(parseOption(argv[++i] ?? ""));
    else if (arg === "--memo") memo = argv[++i] ?? null;
    else if (arg === "--order-id") orderId = argv[++i] ?? null;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--")) usage(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  if (options.length === 0 && process.env.SEND21_PAY_OPTIONS) {
    for (const raw of process.env.SEND21_PAY_OPTIONS.split(",")) if (raw.trim()) options.push(parseOption(raw));
  }
  const [amountRaw, fiatRaw] = positional;
  const fiatAmount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(fiatAmount) || fiatAmount <= 0) usage("amount must be a positive number");
  if (!fiatRaw || !/^[A-Za-z]{3}$/.test(fiatRaw)) usage("fiatCurrency must be a 3 letter ISO 4217 code, e.g. EUR");
  if (options.length === 0) usage("give at least one --option Currency:Network:Address (your own receiving address)");
  return { fiatAmount, fiatCurrency: fiatRaw.toUpperCase(), options, memo, orderId, dryRun };
}

// Minimal JSON Schema check (type, required, properties, items). Enough to catch
// a wrong or missing argument against the schema the live server publishes.
type Schema = { type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema };

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

export function validate(value: unknown, schema: Schema, path = "arguments"): string[] {
  const errors: string[] = [];
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (actual === "integer" && allowed.includes("number"));
    if (!ok) return [`${path}: expected ${allowed.join(" or ")}, got ${actual}`];
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}.${key}: required`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) errors.push(...validate(obj[key], sub, `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items as Schema, `${path}[${i}]`)));
  }
  return errors;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.SEND21_API_KEY;

  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const client = new Client({ name: "send21-example-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers } });
  await client.connect(transport);

  try {
    // tools/list works without an API key.
    const { tools } = await client.listTools();
    console.log(`Connected to ${MCP_URL}. Tools: ${tools.map((t) => t.name).join(", ")}`);
    const tool = tools.find((t) => t.name === TOOL);
    if (!tool) throw new Error(`The server does not offer ${TOOL}`);

    // The server lists every argument as required and accepts null for the optional ones.
    const toolArgs = {
      fiatCurrency: args.fiatCurrency,
      fiatAmount: args.fiatAmount,
      options: args.options,
      orderId: args.orderId,
      memo: args.memo,
      expiryHours: null,
      idempotencyKey: randomUUID(), // safe to retry with the same key
    };

    const problems = validate(toolArgs, tool.inputSchema as Schema);
    if (problems.length > 0) throw new Error(`Arguments do not match the live ${TOOL} schema:\n  ${problems.join("\n  ")}`);
    console.log(`Arguments match the live ${TOOL} input schema.`);

    if (args.dryRun) {
      console.log("Dry run, not calling the tool. Arguments:");
      console.log(JSON.stringify(toolArgs, null, 2));
      return;
    }
    if (!apiKey) {
      throw new Error(
        "SEND21_API_KEY is not set. Create a key with the drafts:write scope at https://send21.io/api-keys, or use --dry-run.",
      );
    }

    const result = await client.callTool({ name: TOOL, arguments: toolArgs });
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    if (result.isError) throw new Error(text || `${TOOL} failed`);

    const request = JSON.parse(text) as { id?: string; payPath?: string; status?: string; expiresAt?: string };
    if (!request.payPath) throw new Error(`No payPath in the response: ${text}`);
    const payLink = new URL(request.payPath, SITE_URL).toString();

    console.log(`Payment request ${request.id} (${request.status}), expires ${request.expiresAt}`);
    console.log(`Pay link: ${payLink}`);
    console.log("Send this link to the payer. They pick a currency, scan one QR and sign in their own wallet.");
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
