import { createServer } from "node:http";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { createApp } from "./app.js";
import { loadBrand } from "./brand.js";

// npm start                mock mode: no key, no network, two browser windows
// APP_MODE=demo npm start  real testnet drafts from the public send21 demo API
// APP_MODE=api  ...        scoped key + webhooks on LIVE networks (needs APP_ALLOW_LIVE=1)

const env = process.env;
const brand = loadBrand();
const dataDir = env.APP_DATA_DIR ?? join(process.cwd(), "data");
const app = createApp({
  brand,
  mode: env.APP_MODE ?? "mock",
  dbFile: env.APP_DB ?? join(dataDir, `${brand.storagePrefix}.sqlite`),
  dataDir,
  apiKey: env.SEND21_API_KEY,
  webhookSecret: env.SEND21_WEBHOOK_SECRET,
  allowLive: env.APP_ALLOW_LIVE === "1",
  publicUrl: env.APP_PUBLIC_URL || undefined,
  push: env.APP_PUSH !== "off",
});

const port = Number(env.PORT ?? 8788);
const host = env.HOST ?? "0.0.0.0";
createServer(app.handler).listen(port, host, () => {
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  console.log(`${brand.name} (${app.mode} mode${app.mode === "api" ? ", LIVE networks" : ", TESTNET"}) on http://localhost:${port}`);
  if (lan) console.log(`On your LAN: http://${lan}:${port}  (push and the service worker need https, see README)`);
  if (app.mode === "mock") console.log(`Two users in one browser: http://localhost:${port}/?as=a and http://localhost:${port}/?as=b`);
});
