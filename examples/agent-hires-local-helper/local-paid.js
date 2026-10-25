// Local test only: sign a draft.confirmed delivery with LOCAL_TEST_WEBHOOK_SECRET and post it
// to this example's own server, to see the "Paid" screen without a real payment.
// The UI labels it "Local test webhook". Real confirmations come from send21, signed with
// SEND21_WEBHOOK_SECRET.   npm run local-paid
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";
import { loadConfig } from "./lib/agent.js";
import { signV2 } from "./lib/webhook.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
loadEnv(dir);
const secret = process.env.LOCAL_TEST_WEBHOOK_SECRET;
if (!secret) { console.error("Set LOCAL_TEST_WEBHOOK_SECRET (the same value the server uses)."); process.exit(1); }
const cfg = loadConfig(dir);
const deliveryId = randomUUID();
const now = new Date().toISOString();
const rawBody = JSON.stringify({ event: "draft.confirmed", data: { draftId: randomUUID(), status: "Confirmed", txId: "LOCAL-TEST-NOT-A-REAL-TRANSACTION", confirmations: 1, sentCurrency: cfg.helper.currency.toUpperCase(), network: cfg.helper.network, fiatCurrency: cfg.task.fiatCurrency, fiatAmount: cfg.task.fiatAmount, orderId: cfg.orderId, confirmedAt: now, occurredAt: now } });
const send = () => fetch(`http://localhost:${process.env.PORT || 3022}/webhooks/send21`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Send21-Event": "draft.confirmed", "X-Send21-Delivery": deliveryId, "X-Send21-Signature-V2": signV2({ rawBody, deliveryId, secret }) },
  body: rawBody,
});
const a = await send();
console.log(`local test delivery ${deliveryId} -> HTTP ${a.status} ${await a.text()}`);
const b = await send(); // the same delivery again, as a retry would arrive
console.log(`same delivery id again          -> HTTP ${b.status} ${await b.text()}`);
