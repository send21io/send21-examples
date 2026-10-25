// A simple script standing in for the agent: the task is reported done, so it asks
// send21 (over MCP) for a pay link to the helper's saved address. Then it asks
// again, the way a retried or repeated agent run would, to show the same open link comes back.
//   npm run agent
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadEnv, redact } from "./lib/env.js";
import { mcpClient } from "./lib/mcp.js";
import { loadConfig, draftPaymentForDoneTask, readPaymentStatus } from "./lib/agent.js";
import { chunk } from "./lib/address.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
loadEnv(dir);

// Clean up a test pay link: npm run agent -- --cancel <paymentRequestId>
if (process.argv[2] === "--cancel") {
  const { client } = await import("./lib/send21.js");
  const pr = await client().post(`/payment-requests/${process.argv[3]}/cancel`);
  console.log(`Cancelled test pay link ${pr.id}: status ${pr.status}`);
  process.exit(0);
}
const cfg = loadConfig(dir);
const mcp = mcpClient();
const say = (s = "") => console.log(s);

say(`MCP server: ${mcp.url}   key: ${redact(process.env.SEND21_API_KEY)}`);
say(`\nTask: ${cfg.task.title} (${cfg.task.where})`);
say(`Helper: ${cfg.helper.label}, ${cfg.task.fiatAmount} ${cfg.task.fiatCurrency} in ${cfg.helper.currency.toUpperCase()} on ${cfg.helper.network}`);
say(`Saved helper address (${cfg.fileName}): ${chunk(cfg.helper.address).join(" ")}`);
say(`\n[helper] task reported done -> agent drafts the payment`);

const first = await draftPaymentForDoneTask(mcp, cfg, { idempotencyKey: `${cfg.orderId}-${randomUUID()}` });
for (const s of first.steps) say(`  agent -> ${s.tool.padEnd(23)} ${s.result}`);
if (first.stopped) { say(`\n  STOPPED: ${first.reason}`); process.exit(0); }
say(`\n  pay link:  ${first.payUrl}`);
say(`  id:        ${first.paymentRequest.id}`);
say(`  orderId:   ${first.paymentRequest.orderId}`);
say(`  amount:    ${first.paymentRequest.fiatAmount} ${first.paymentRequest.fiatCurrency}, payable in ${first.paymentRequest.option.currency.toUpperCase()} on ${first.paymentRequest.option.network}`);
say(`  pays to:   ${chunk(first.paymentRequest.option.address).join(" ")}`);
say(`  check:     ${first.addressCheck.match ? (first.approvedInSend21 ? "MATCH, the pay link pays the helper's pre-approved address (verified in send21)" : "MATCH, the pay link pays the helper address you saved (not in the send21 address book)") : "MISMATCH, do not pay"}`);

say(`\n[helper] reports done again (a repeated request, new Idempotency-Key)`);
const again = await draftPaymentForDoneTask(mcp, cfg, { idempotencyKey: `${cfg.orderId}-${randomUUID()}` });
say(`  agent -> create_payment_request (reuseOpenForOrder: true) -> ${again.paymentRequest.id}`);
say(`  ${again.paymentRequest.id === first.paymentRequest.id ? "same open link returned, no second link was created" : "a different link came back (the first one was no longer open)"}`);

const st = await readPaymentStatus(mcp, first.paymentRequest.id);
say(`\nagent -> get_payment_request: status ${st.status}${st.draftStatus ? `, draft ${st.draftStatus}` : ""}`);
say(`\nNext: the owner opens the pay link, checks the full address in their own wallet and signs.`);
say(`The agent never signs and never pays. Paid shows up as a signed draft.confirmed webhook.`);
