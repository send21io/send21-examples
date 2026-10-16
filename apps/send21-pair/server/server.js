import { createServer } from "node:http";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { createApp } from "./app.js";

// npm start                 mock mode: no key, no network, two browser windows
// PAIR_MODE=demo npm start  real testnet drafts from the public send21 demo API
// PAIR_MODE=api  ...        scoped key + webhooks on LIVE networks (needs PAIR_ALLOW_LIVE=1)

const env = process.env;
const dataDir = env.PAIR_DATA_DIR ?? join(process.cwd(), "data");
const app = createApp({
  mode: env.PAIR_MODE ?? "mock",
  dbFile: env.PAIR_DB ?? join(dataDir, "pair.sqlite"),
  dataDir,
  apiKey: env.SEND21_API_KEY,
  webhookSecret: env.SEND21_WEBHOOK_SECRET,
  allowLive: env.PAIR_ALLOW_LIVE === "1",
  publicUrl: env.PAIR_PUBLIC_URL || undefined,
  push: env.PAIR_PUSH !== "off",
  trustProxy: env.PAIR_TRUST_PROXY === "1", // rate limits per X-Forwarded-For behind your own proxy
});

const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? "0.0.0.0";
createServer(app.handler).listen(port, host, () => {
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  console.log(`send21 pair (${app.mode} mode${app.mode === "api" ? ", LIVE networks" : ", TESTNET"}) on http://localhost:${port}`);
  if (lan) console.log(`On your LAN: http://${lan}:${port}  (push and the service worker need https, see README)`);
  if (app.mode === "mock") console.log(`Two users in one browser: http://localhost:${port}/?as=anna and http://localhost:${port}/?as=bo`);
});
