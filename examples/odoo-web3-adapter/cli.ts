// bun cli.ts pay-link <invoice move id>
// bun cli.ts bill-draft <bill move id> <0x vendor address> <Base|Ethereum|Arbitrum|Polygon> <Usdc|Usdt|Eurc>
// bun cli.ts enrich-pending      (after odoo-web3's sync has imported new transfers)
import { createBillDraft, createInvoicePayLink, enrichPending } from "./src/adapter.ts";
import { loadConfig } from "./src/config.ts";
import { odooClient } from "./src/odoo.ts";
import type { EvmNetwork, Token } from "./src/send21.ts";
import { fileStore } from "./src/store.ts";

const cfg = loadConfig();
const deps = { odoo: odooClient(cfg.odoo), store: fileStore(cfg.storePath), config: cfg.adapter };
const [cmd, id, address, network, currency] = process.argv.slice(2);

if (cmd === "pay-link" && id) console.log(await createInvoicePayLink(Number(id), deps));
else if (cmd === "bill-draft" && id && address && network && currency)
  console.log(await createBillDraft(Number(id), { address, network: network as EvmNetwork, currency: currency as Token }, deps));
else if (cmd === "enrich-pending") console.log(await enrichPending(deps));
else {
  console.error("usage: cli.ts pay-link <id> | bill-draft <id> <0x address> <network> <token> | enrich-pending");
  process.exit(1);
}
