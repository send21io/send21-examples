import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, verifySignature } from "./verify.js";

const MAX_BODY_BYTES = 1024 * 1024;

// Delivery rules from the Webhooks section of https://send21.io/swagger:
// - Any 2xx response counts as delivered.
// - Anything else, or no answer within 15 seconds, is retried after 1, 2, 4, 8
//   minutes and so on, up to 8 attempts. Retries reuse X-Send21-Delivery.
// - Deliveries can arrive out of order.
// So: answer quickly (do slow work after replying or in a queue), answer 2xx
// for events you do not care about, and never move an order backwards, for
// example from paid to waiting because a late draft.seen arrived.

/**
 * Handle a verified event. Keep this idempotent: key your own records on
 * draftId (and orderId) so a repeated event does not double count.
 * @param {{ event: string, data?: Record<string, any> }} payload
 * @param {(line: string) => void} log
 * @returns {string} what the handler did
 */
export function handleEvent(payload, log = console.log) {
  const data = payload.data ?? {};
  switch (payload.event) {
    case "draft.confirmed":
      // The payment reached the required confirmations (for Lightning: the
      // provider confirmed it with a valid preimage). Mark your order paid here.
      log(
        `confirmed: order=${data.orderId ?? "-"} draft=${data.draftId} ` +
          `${data.sentAmount ?? "?"} ${data.sentCurrency ?? ""} on ${data.network ?? "?"} tx=${data.txId ?? "-"}`,
      );
      return "order_paid";
    case "draft.amount_mismatch":
      // A transfer within 10% of the billed amount arrived, but not the exact
      // amount (for example an exchange withdrawal that deducted a fee). It does
      // not pay the draft. Do not mark the order paid. Flag it for a human, who
      // can accept it in the send21 app or with POST /api/v1/drafts/{id}/accept-received.
      log(
        `amount mismatch, needs review: order=${data.orderId ?? "-"} draft=${data.draftId} ` +
          `received ${data.receivedAmount ?? "?"} ${data.sentCurrency ?? ""}, billed ${data.sentAmount ?? "?"} ${data.sentCurrency ?? ""} ` +
          `on ${data.network ?? "?"} tx=${data.txId ?? "-"} confirmations=${data.confirmations ?? "?"}`,
      );
      return "needs_review";
    case "draft.seen":
      // A payment was seen but is not confirmed yet. Also sent with
      // acceptedByOwner: true when the owner accepts a payment with a different
      // amount. Wait for draft.confirmed before marking the order paid.
      log(
        `seen: order=${data.orderId ?? "-"} draft=${data.draftId} tx=${data.txId ?? "-"}` +
          (data.acceptedByOwner === true ? " (different amount accepted by owner)" : ""),
      );
      return "payment_seen";
    case "test":
      log(`test event: ${data.message ?? ""}`);
      return "test";
    default:
      // draft.created, draft.expired, draft.cancelled and any future event.
      log(`ignored event ${payload.event}`);
      return "ignored";
  }
}

/**
 * Remembers X-Send21-Delivery ids so a retried delivery is handled once.
 * In memory and bounded here; use your database in production so it survives restarts.
 */
export function createDeliveryStore(max = 10_000) {
  const ids = new Set();
  return {
    has: (id) => ids.has(id),
    add: (id) => {
      ids.add(id);
      if (ids.size > max) ids.delete(ids.values().next().value);
    },
  };
}

/**
 * @param {{ secret: string, path?: string, log?: (line: string) => void, deliveries?: { has(id: string): boolean, add(id: string): void } }} options
 */
export function createWebhookServer({ secret, path = "/webhooks/send21", log = console.log, deliveries = createDeliveryStore() }) {
  if (!secret) throw new Error("A webhook secret is required (SEND21_WEBHOOK_SECRET).");

  return createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method !== "POST" || req.url !== path) return reply(404, { error: "not found" });

    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413, { error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      const rawBody = Buffer.concat(chunks);

      if (!verifySignature(rawBody, req.headers[SIGNATURE_HEADER], secret)) {
        log("rejected delivery with a missing or invalid signature");
        return reply(401, { error: "invalid signature" });
      }

      // Only the body is signed. Take the event type from the body; the
      // X-Send21-Event header carries the same value and is useful for routing logs.
      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply(400, { error: "invalid json" });
      }
      if (!payload || typeof payload.event !== "string") return reply(400, { error: "missing event" });

      const deliveryId = req.headers[DELIVERY_HEADER];
      if (typeof deliveryId === "string" && deliveries.has(deliveryId)) {
        log(`duplicate delivery ${deliveryId} (${req.headers[EVENT_HEADER] ?? payload.event}), already handled`);
        return reply(200, { ok: true, outcome: "duplicate" });
      }

      const outcome = handleEvent(payload, log);
      if (typeof deliveryId === "string") deliveries.add(deliveryId);
      reply(200, { ok: true, outcome });
    });
  });
}

// Run directly: node server.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
  } catch {
    // No .env file, rely on the environment.
  }
  const port = Number(process.env.PORT ?? 3000);
  const server = createWebhookServer({ secret: process.env.SEND21_WEBHOOK_SECRET ?? "" });
  server.listen(port, () => console.log(`Listening on http://localhost:${port}/webhooks/send21`));
}
