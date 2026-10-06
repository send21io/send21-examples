// Send a locally signed sample event to the running receiver, for manual testing.
// It sets the same headers as a send21 delivery: X-Send21-Event, X-Send21-Delivery
// and X-Send21-Signature. To get a real signed delivery from send21 instead, call
// POST /api/v1/webhooks/{id}/test.
// Usage: node send-sample.js [draft.confirmed|draft.amount_mismatch|test]
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { samples } from "./samples.js";
import { sign } from "./verify.js";

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

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-send21-event": event,
    "x-send21-delivery": randomUUID(),
    "x-send21-signature": sign(body, secret),
  },
  body,
});
console.log(res.status, await res.text());
