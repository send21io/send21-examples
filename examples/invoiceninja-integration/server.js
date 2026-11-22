// Two webhook endpoints, no dependencies:
//   POST /invoiceninja/webhook  Invoice Ninja "create_invoice" -> send21 pay link on the invoice
//   POST /send21/webhook        send21 events -> payment recorded in Invoice Ninja
import { createServer } from "node:http";

import { loadConfig } from "./src/config.js";
import { handleInvoiceNinjaWebhook, handleSend21Webhook } from "./src/handlers.js";
import { invoiceNinjaClient } from "./src/invoiceninja.js";
import { fileStore } from "./src/store.js";

const config = loadConfig();
const deps = {
  config,
  api: invoiceNinjaClient({ baseUrl: config.invoiceNinjaUrl, token: config.invoiceNinjaToken }),
  store: fileStore(config.storePath),
};

const routes = { "/invoiceninja/webhook": handleInvoiceNinjaWebhook, "/send21/webhook": handleSend21Webhook };

createServer(async (req, res) => {
  const handler = routes[new URL(req.url, "http://localhost").pathname];
  if (req.method !== "POST" || !handler) return res.writeHead(404).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const out = await handler({ headers: req.headers, body: Buffer.concat(chunks) }, deps);
    res.writeHead(out.status, { "Content-Type": "application/json" }).end(out.body);
  } catch (err) {
    console.error(err.message);
    res.writeHead(500).end(); // send21 retries with the same X-Send21-Delivery
  }
}).listen(config.port, () => console.log(`listening on :${config.port}`));
