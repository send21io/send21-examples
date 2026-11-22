// POST /send21/webhook. Run with Bun (`bun server.ts`) or Node.js 22.18+ (`node server.ts`).
import { createServer } from "node:http";

import { handleWebhook } from "./src/adapter.ts";
import { loadConfig } from "./src/config.ts";
import { odooClient } from "./src/odoo.ts";
import { fileStore } from "./src/store.ts";

const cfg = loadConfig();
const deps = { odoo: odooClient(cfg.odoo), store: fileStore(cfg.storePath), config: cfg.adapter };

createServer(async (req, res) => {
  if (req.method !== "POST" || new URL(req.url ?? "/", "http://x").pathname !== "/send21/webhook") return res.writeHead(404).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    const out = await handleWebhook({ headers: req.headers, body: Buffer.concat(chunks) }, deps);
    res.writeHead(out.status, { "Content-Type": "application/json" }).end(out.body);
  } catch (err) {
    console.error((err as Error).message);
    res.writeHead(500).end(); // send21 retries with the same X-Send21-Delivery
  }
}).listen(cfg.port, () => console.log(`send21 webhook on :${cfg.port}/send21/webhook`));
