import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { SIGNATURE_HEADER, verifySignature } from "./verify.js";

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Handle a verified event. Keep this idempotent: key your own records on
 * draftId (and orderId) so a repeated event does not double count.
 * @param {{ event: string, data?: Record<string, unknown> }} payload
 * @param {(line: string) => void} log
 * @returns {string} what the handler did
 */
export function handleEvent(payload, log = console.log) {
  const data = payload.data ?? {};
  switch (payload.event) {
    case "draft.confirmed":
      // The payment reached the receiving address with the required confirmations.
      // Mark your order paid here.
      log(
        `confirmed: order=${data.orderId ?? "-"} draft=${data.draftId} ` +
          `${data.sentAmount ?? "?"} ${data.sentCurrency ?? ""} on ${data.network ?? "?"} tx=${data.txId ?? "-"}`,
      );
      return "order_paid";
    case "draft.amount_mismatch":
      // A transfer with a different amount arrived (for example an exchange
      // withdrawal that deducted a fee). send21 does not confirm it on its own.
      // Do not mark the order paid. Flag it for a human, who can accept it as
      // paid in the send21 app or with POST /api/v1/drafts/{id}/accept-received.
      log(`amount mismatch, needs review: order=${data.orderId ?? "-"} draft=${data.draftId} data=${JSON.stringify(data)}`);
      return "needs_review";
    default:
      log(`ignored event ${payload.event}`);
      return "ignored";
  }
}

/**
 * @param {{ secret: string, path?: string, log?: (line: string) => void }} options
 */
export function createWebhookServer({ secret, path = "/webhooks/send21", log = console.log }) {
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

      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply(400, { error: "invalid json" });
      }
      if (!payload || typeof payload.event !== "string") return reply(400, { error: "missing event" });

      const outcome = handleEvent(payload, log);
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
