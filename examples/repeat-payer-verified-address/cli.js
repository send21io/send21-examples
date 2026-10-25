// Terminal version of the same flow, for the tutorial and the demo video.
//   npm run monthly            create (or return) this month's draft and check the address
//   npm run monthly -- --schedule   also set up the monthly recurring template
//   npm run monthly -- --cancel <draftId>   cancel a test draft
import { fileURLToPath } from "node:url";
import { loadEnv, redact } from "./lib/env.js";
import { client } from "./lib/send21.js";
import { loadPayee, resolveApproval } from "./lib/payee.js";
import { createMonthlyDraft, ensureMonthlyTemplate } from "./lib/monthly.js";
import { chunk } from "./lib/address.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
loadEnv(dir);
const args = process.argv.slice(2);
const api = client();
const line = (s = "") => console.log(s);
const ok = (b) => (b ? "MATCH" : "MISMATCH");

line(`send21 API: ${api.baseUrl}   key: ${redact(process.env.SEND21_API_KEY)}`);

if (args[0] === "--cancel") {
  const d = await api.post(`/drafts/${args[1]}/cancel`);
  line(`Cancelled test draft ${d.id}: status ${d.status}`);
  process.exit(0);
}
if (args[0] === "--pause-template") {
  const t = await api.post(`/recurring-templates/${args[1]}/pause`);
  line(`Paused recurring template ${t.id}: isActive ${t.isActive}`);
  process.exit(0);
}

const payee = loadPayee(dir);
const approval = await resolveApproval(api, payee);
// "approved" only for an owner-verified send21 address book entry; otherwise "saved".
const kind = approval.verified ? "approved payee" : "saved payee";
line(`\n1) ${approval.verified ? "Approved" : "Saved"} payee (stored once, in ${payee.fileName})`);
line(`   ${payee.label}: ${payee.currency.toUpperCase()} on ${payee.network}, ${payee.fiatAmount} ${payee.fiatCurrency} a month`);
line(`   address: ${chunk(payee.address).join(" ")}`);
line(`   source:  ${approval.source}${approval.verified ? ` (verified ${approval.verifiedAt})` : ""}`);
line(`   note:    ${approval.note}`);

if (args.includes("--schedule")) {
  const t = await ensureMonthlyTemplate(api, payee);
  line(`\n2) Monthly recurring template (POST /recurring-templates)`);
  line(`   ${t.reused ? "reused existing" : "created"} template ${t.template.id}, interval ${t.template.interval}, next run ${t.template.nextRunAt}, active ${t.template.isActive}`);
  line(`   template receiver: ${chunk(t.template.draft?.receiverAddress ?? "").join(" ")}`);
  line(`   check: ${ok(t.check.match)} with the ${kind}`);
}

line(`\n${args.includes("--schedule") ? "3" : "2"}) This month's draft (POST /drafts, Idempotency-Key per payee and month)`);
const r = await createMonthlyDraft(api, payee);
line(`   Idempotency-Key: ${r.idempotencyKey}`);
line(`   draft ${r.draft.id}  status ${r.draft.status}  ${r.draft.fiatAmount} ${r.draft.fiatCurrency} = ${(r.draft.amountBaseUnits / 1e6).toFixed(6)} ${r.draft.currency?.toUpperCase()} on ${r.draft.network}`);
if (r.requoted) line(`   price lock had run out: re-quoted (POST /drafts/{id}/requote), same draft`);
line(`   price locked until ${r.draft.quote?.lockedUntil ?? r.draft.quote?.expiresAt ?? "n/a"}; draft expires ${r.draft.expiresAt}`);
line(`   paymentUri: ${r.draft.paymentUri}`);

line(`\n   Full address check (exact, every character):`);
line(`   ${(approval.verified ? "approved" : "saved").padEnd(22)} ${chunk(payee.address).join(" ")}`);
for (const c of r.checks.checks) line(`   ${c.where.padEnd(22)} ${chunk(c.value ?? "").join(" ")}   ${ok(c.match)}`);
line(r.checks.allMatch
  ? `\n   ✔ Address matches your ${kind} (${payee.address.length} of ${payee.address.length} characters).`
  : `\n   ✖ STOP: an address does not match the ${kind}. Do not pay this draft.`);
line(`\n   Next: open the paymentUri or scan the QR in your own wallet. Your wallet shows the full address;`);
line(`   compare it with the ${approval.verified ? "approved" : "saved"} one before you sign. send21 never signs and never broadcasts.`);
const s = await api.get(`/drafts/${r.draft.id}/status`);
line(`\n   GET /drafts/${s.id}/status -> ${s.status}`);
