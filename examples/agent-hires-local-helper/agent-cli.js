// A simple script standing in for the agent: the task is reported done, so it asks send21
// for a payment draft to the helper's saved address. Then it asks again, the way a retried
// or repeated agent run would, to show the same draft comes back (same Idempotency-Key).
//   npm run agent
import { fileURLToPath } from "node:url";
import { loadEnv, redact } from "./lib/env.js";
import { mcpClient } from "./lib/mcp.js";
import { client } from "./lib/send21.js";
import { loadConfig, draftPaymentForDoneTask, readDraftStatus } from "./lib/agent.js";
import { chunk } from "./lib/address.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
loadEnv(dir);
const api = client();

// Clean up a test draft: npm run agent -- --cancel <draftId>
if (process.argv[2] === "--cancel") {
  const d = await api.post(`/drafts/${process.argv[3]}/cancel`);
  console.log(`Cancelled test draft ${d.id}: status ${d.status}`);
  process.exit(0);
}

const cfg = loadConfig(dir);
const mcp = mcpClient();
const say = (s = "") => console.log(s);

say(`MCP server: ${mcp.url}   REST: ${api.baseUrl}/api/v1   key: ${redact(process.env.SEND21_API_KEY)}`);
say(`\nTask: ${cfg.task.title} (${cfg.task.where}), task id ${cfg.task.id}`);
say(`Helper: ${cfg.helper.label}, ${cfg.task.fiatAmount} ${cfg.task.fiatCurrency} in ${cfg.helper.currency.toUpperCase()} on ${cfg.helper.network}`);
say(`Saved helper address (${cfg.fileName}): ${chunk(cfg.helper.address).join(" ")}`);
say(`\n[helper] task reported done -> agent drafts the payment`);

const first = await draftPaymentForDoneTask({ mcp, api }, cfg);
for (const s of first.steps) say(`  agent -> ${s.tool.padEnd(23)} ${s.result}`);
if (first.stopped) { say(`\n  STOPPED: ${first.reason}`); process.exit(0); }
const d = first.draft;
say(`\n  draft:     ${d.id}  status ${d.status}`);
say(`  amount:    ${d.fiatAmount} ${d.fiatCurrency} = ${(d.amountBaseUnits / 1e6).toFixed(6)} ${d.currency.toUpperCase()} on ${d.network}`);
say(`  price locked until ${d.lockedUntil}; draft expires ${d.expiresAt}`);
say(`  pays to:   ${chunk(d.receiverAddress).join(" ")}`);
say(`  check:     ${first.addressCheck.match ? (first.approvedInSend21 ? "MATCH, the draft pays the helper's pre-approved address (verified in send21)" : "MATCH, the draft pays the helper address you saved (not in the send21 address book)") : "MISMATCH, do not pay"}`);
say(`  paymentUri (open or scan in your own wallet): ${d.paymentUri}`);

say(`\n[helper] reports done again (a repeated request, same task id)`);
const again = await draftPaymentForDoneTask({ mcp, api }, cfg);
say(`  agent -> POST /drafts (Idempotency-Key ${cfg.idempotencyKey}) -> ${again.draft?.id}`);
say(`  ${again.draft?.id === d.id ? "same draft returned, no second draft was created" : "a different draft came back"}`);

const st = await readDraftStatus(mcp, d.id);
say(`\nagent -> get_draft_status: ${st.status}`);
say(`\nNext: the owner opens the payment in their own wallet, checks the full address there and signs.`);
say(`The agent never signs and never pays. Paid shows up as a signed draft.confirmed webhook.`);
