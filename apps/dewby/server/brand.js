// Reads web/brand.js (a browser script that sets window.BRAND) on the server, so the
// wallet memo and logs use the same name as the UI. One brand file for both sides.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

export const BRAND_FILE = fileURLToPath(new URL("../web/brand.js", import.meta.url));

export function loadBrand(file = BRAND_FILE) {
  const window = {};
  runInNewContext(readFileSync(file, "utf8"), { window }, { filename: file, timeout: 1000 });
  if (!window.BRAND?.name) throw new Error(`${file} must set window.BRAND.name`);
  return window.BRAND;
}
