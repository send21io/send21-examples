// Send a locally signed sample event to the running receiver, for manual testing.
// It sets the same headers as a send21 delivery: X-Send21-Event, X-Send21-Delivery
// X-Send21-Timestamp, X-Send21-Signature-V2 and the legacy X-Send21-Signature. To get a real signed delivery from send21 instead, call
// POST /api/v1/webhooks/{id}/test.
// Usage: node send-sample.js [draft.confirmed|draft.confirmed-accepted|draft.amount_mismatch|test]
// draft.confirmed-accepted is a draft.confirmed after the owner accepted a
// different amount; the event type sent is draft.confirmed.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { samples } from "./samples.js";
import { sign, signV2 } from "./verify.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env file, rely on the environment.
}

const secret = process.env.SEND21_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set SEND21_WEBHOOK_SECRET first.");
  process.exit(1);
}
const url = `http://localhost:${process.env.PORT ?? 3000}/webhooks/send21`;
const event = process.argv[2] ?? "draft.confirmed";

const body = samples[event];
if (!body) {
  console.error(`Unknown sample ${event}. Use one of: ${Object.keys(samples).join(", ")}`);
  process.exit(1);
}

const delivery = randomUUID();
const timestamp = Math.floor(Date.now() / 1000);
const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-send21-event": JSON.parse(body).event,
    "x-send21-delivery": delivery,
    "x-send21-timestamp": String(timestamp),
    "x-send21-signature-v2": signV2(body, delivery, timestamp, secret),
    "x-send21-signature": sign(body, secret), // legacy, still sent for compatibility
  },
  body,
});
console.log(res.status, await res.text());
