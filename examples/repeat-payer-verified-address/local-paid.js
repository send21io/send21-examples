// Local test only: sign a draft.confirmed delivery with LOCAL_TEST_WEBHOOK_SECRET and post it
// to this example's own server, so you can see the "Paid" screen without a real payment.
// The UI labels it "Local test webhook". Real confirmations come from send21, signed with
// SEND21_WEBHOOK_SECRET.   npm run local-paid -- <draftId>
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";
import { loadPayee } from "./lib/payee.js";
import { signV2 } from "./lib/webhook.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
loadEnv(dir);
const secret = process.env.LOCAL_TEST_WEBHOOK_SECRET;
const draftId = process.argv[2];
if (!secret || !draftId) { console.error("Set LOCAL_TEST_WEBHOOK_SECRET and pass a draft id."); process.exit(1); }
const payee = loadPayee(dir);
const deliveryId = randomUUID();
const now = new Date().toISOString();
const rawBody = JSON.stringify({ event: "draft.confirmed", data: { draftId, status: "Confirmed", txId: "LOCAL-TEST-NOT-A-REAL-TRANSACTION", confirmations: 1, sentCurrency: payee.currency.toUpperCase(), network: payee.network, confirmedAt: now, occurredAt: now } });
const res = await fetch(`http://localhost:${process.env.PORT || 3021}/webhooks/send21`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Send21-Event": "draft.confirmed", "X-Send21-Delivery": deliveryId, "X-Send21-Signature-V2": signV2({ rawBody, deliveryId, secret }) },
  body: rawBody,
});
console.log(`local test delivery ${deliveryId} -> HTTP ${res.status}`);
