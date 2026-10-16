// dewby reuses the send21-pair server unchanged: server-side receiver addresses, Idempotency-Key
// handling, V2 webhook signature checks, SQLite delivery dedupe and amount/asset/network mismatch
// handling all live in ../../send21-pair/server/. This file only points it at dewby's UI and brand.
import { fileURLToPath } from "node:url";
import { createApp as createPairApp } from "../../send21-pair/server/app.js";
import { loadBrand } from "./brand.js";

export const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
/** Shared browser code (lib/, vendor/) that dewby's web/ doesn't override. */
export const SHARED_WEB_DIR = fileURLToPath(new URL("../../send21-pair/web/", import.meta.url));

export function createApp(config = {}) {
  const brand = config.brand ?? loadBrand();
  return createPairApp({
    webDirs: [WEB_DIR, { dir: SHARED_WEB_DIR, only: ["lib/", "vendor/"] }],
    memoPrefix: brand.name,
    bootGlobal: "APP_BOOT",
    liveEnv: "APP_ALLOW_LIVE",
    ...config,
  });
}
