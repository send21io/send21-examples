import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { DELIVERY_HEADER, EVENT_HEADER, verifyDelivery } from "../webhook-receiver/verify.js";
import { applyDelivery, openStore } from "./store.js";

// Same receiver as ../webhook-receiver, but the delivery-id check is durable:
// the X-Send21-Delivery id and the bookkeeping update are committed in one
// SQLite transaction, and only then does it answer 2xx. A restart, a lost
// answer or a crash halfway can therefore not apply an update twice or lose it.
// See README.md for the atomicity boundary.
//
// Delivery rules (Webhooks section of https://send21.io/swagger): any 2xx counts
// as delivered; anything else, or no answer within 15 seconds, is retried with
// the same X-Send21-Delivery. So answer 5xx when the commit fails, and keep the
// transaction short.

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @param {{
 *   secret: string,
 *   store: ReturnType<typeof openStore>,
 *   path?: string,
 *   log?: (line: string) => void,
 *   allowLegacy?: boolean,
 *   hooks?: { beforeCommit?: () => void, afterCommit?: (res: import("node:http").ServerResponse) => boolean | void },
 * }} options
 * allowLegacy: default false here. The legacy X-Send21-Signature signs the body only, not
 * X-Send21-Delivery, so a replayed body could carry a fresh delivery id past the store.
 * hooks: test-only fault injection. afterCommit returning true means "do not answer".
 */
export function createWebhookServer({ secret, store, path = "/webhooks/send21", log = console.log, allowLegacy = false, hooks = {} }) {
  if (!secret) throw new Error("A webhook secret is required (SEND21_WEBHOOK_SECRET).");
  if (!store) throw new Error("A store is required (openStore).");

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

      // 1. Verify X-Send21-Signature-V2 over "<timestamp>.<delivery id>.<raw body>",
      //    constant-time, at most 300 s old. A V2 header that is present but invalid
      //    is rejected; it never falls back to the legacy header.
      const { valid, scheme } = verifyDelivery(rawBody, req.headers, secret, { allowLegacy });
      if (!valid) {
        log(`rejected delivery with a missing, expired or invalid signature (${scheme ?? "none"})`);
        return reply(401, { error: "invalid signature" });
      }

      const deliveryId = req.headers[DELIVERY_HEADER];
      if (typeof deliveryId !== "string" || !deliveryId) return reply(400, { error: "missing X-Send21-Delivery" });

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply(400, { error: "invalid json" });
      }
      if (!payload || typeof payload.event !== "string") return reply(400, { error: "missing event" });

      // 2. One transaction: insert the delivery id if absent, apply the update, COMMIT.
      let result;
      try {
        result = applyDelivery(store, deliveryId, payload, { beforeCommit: hooks.beforeCommit });
      } catch (err) {
        // Rolled back: nothing of this delivery is stored, so send21's retry
        // (same delivery id) applies it from scratch.
        log(`delivery ${deliveryId} not stored, rolled back: ${err.message}`);
        return reply(500, { error: "not stored, retry" });
      }

      // 3. Answer only after COMMIT.
      if (hooks.afterCommit?.(res) === true) return;
      if (result.duplicate) {
        log(`duplicate delivery ${deliveryId} (${req.headers[EVENT_HEADER] ?? payload.event}), already committed, no-op`);
        return reply(200, { ok: true, outcome: "duplicate" });
      }
      log(`delivery ${deliveryId} committed: ${payload.event} -> ${result.outcome}`);
      reply(200, { ok: true, outcome: result.outcome });
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
  const file = process.env.SEND21_WEBHOOK_DB ?? fileURLToPath(new URL("./data/webhooks.db", import.meta.url));
  const store = openStore(file);
  const server = createWebhookServer({ secret: process.env.SEND21_WEBHOOK_SECRET ?? "", store });
  server.listen(port, () => console.log(`Listening on http://localhost:${port}/webhooks/send21 (store: ${file})`));
}
