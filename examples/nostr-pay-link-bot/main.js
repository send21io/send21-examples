// The DM bot: answers NIP-17 DMs with send21 pay links and tells the payer when it confirms.
//   node --env-file=.env main.js
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

import { SimplePool, getPublicKey } from "nostr-tools";

import { handleDirectMessage, handleWebhook, npubOf, parseMenu, rateLimiter, secretKeyFrom } from "./src/bot.js";
import { parseOptions } from "./src/send21.js";

const env = process.env;
const need = (k) => env[k] || (console.error(`${k} is not set (see .env.example)`), process.exit(1));
const secretKey = secretKeyFrom(need("NOSTR_SECRET_KEY"));
const relays = need("NOSTR_RELAYS").split(",").map((s) => s.trim()).filter(Boolean);
const config = {
  send21ApiKey: need("SEND21_API_KEY"),
  send21WebhookSecret: need("SEND21_WEBHOOK_SECRET"),
  declineNote: env.SEND21_DECLINE_NOTE,
  expiryHours: env.SEND21_EXPIRY_HOURS || 24,
};

// Small JSON file so links and handled deliveries survive a restart.
const storePath = env.STORE_PATH || "./nostr-bot-state.json";
const saved = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : { links: [], deliveries: [] };
const links = new Map(saved.links);
const deliveries = new Set(saved.deliveries);
const persist = () => {
  writeFileSync(`${storePath}.tmp`, JSON.stringify({ links: [...links], deliveries: [...deliveries].slice(-5000) }));
  renameSync(`${storePath}.tmp`, storePath);
};

const deps = { secretKey, menu: parseMenu(need("BOT_MENU")), options: parseOptions(need("SEND21_OPTIONS")), config, allow: rateLimiter(), links, deliveries };
const pool = new SimplePool();
const publish = (event) => Promise.any(pool.publish(relays, event)).catch((e) => console.error("publish failed", e?.message));

pool.subscribe(relays, { kinds: [1059], "#p": [getPublicKey(secretKey)], since: Math.floor(Date.now() / 1000) - 2 * 24 * 3600 }, {
  async onevent(wrap) {
    try {
      const reply = await handleDirectMessage(wrap, deps);
      if (reply) {
        persist();
        await publish(reply);
      }
    } catch (e) {
      console.error("DM failed:", e.message);
    }
  },
});

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/send21/webhook") return res.writeHead(404).end();
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const out = handleWebhook({ headers: req.headers, body: Buffer.concat(chunks) }, deps);
  persist();
  if (out.dm) await publish(out.dm);
  res.writeHead(out.status).end();
}).listen(Number(env.PORT || 8791));

console.log(`Bot ${npubOf(secretKey)} on ${relays.join(", ")}; webhook on :${env.PORT || 8791}/send21/webhook`);
