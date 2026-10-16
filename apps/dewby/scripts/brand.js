// Applies web/brand.js to the files a browser reads before any script runs:
//   web/manifest.webmanifest   name, colors
//   web/index.html             <title>, description, theme-color, home-screen title
//   web/icons/icon-*.png       PWA icons drawn from web/icons/mark.svg (needs Chrome)
//   web/og.png, web/shots/     share card and manifest screenshots: npm run screenshots (then npm run og)
// Usage: npm run brand   (PNG icons: PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/usr/bin/google-chrome npm run brand)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadBrand } from "../server/brand.js";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const B = loadBrand();
const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const manifest = {
  name: `${B.name} (testnet)`,
  short_name: B.name,
  description: B.description,
  start_url: "./",
  scope: "./",
  display: "standalone",
  orientation: "portrait",
  background_color: B.light.bg,
  theme_color: B.light.bg,
  id: "./",
  lang: "en",
  dir: "ltr",
  categories: ["finance", "social", "utilities"],
  shortcuts: [
    { name: "Request", url: "./#/new?mode=request", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] },
    { name: "Split a bill", url: "./#/new?mode=request&split=1", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] },
    { name: "My code", url: "./#/me", icons: [{ src: "icons/icon-192.png", sizes: "192x192" }] },
  ],
  screenshots: [
    { src: "shots/home.png", sizes: "780x1688", type: "image/png", form_factor: "narrow", label: "Home: what you're owed, four actions, friends" },
    { src: "shots/paid.png", sizes: "780x1688", type: "image/png", form_factor: "narrow", label: "Paid" },
    { src: "shots/desktop.png", sizes: "1280x860", type: "image/png", form_factor: "wide", label: "On desktop" },
  ],
  icons: [
    { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    { src: "icons/mark.svg", sizes: "any", type: "image/svg+xml" },
  ],
};
writeFileSync(`${web}manifest.webmanifest`, `${JSON.stringify(manifest, null, 2)}\n`);

let html = readFileSync(`${web}index.html`, "utf8");
html = html
  .replace(/<title>[^<]*<\/title>/, `<title>${escAttr(B.name)} · testnet</title>`)
  .replace(/(<meta name="description" content=")[^"]*"/, `$1${escAttr(B.description)}"`)
  .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*"/, `$1${escAttr(B.name)}"`)
  .replace(/(<meta name="theme-color" content=")[^"]*"/, `$1${escAttr(B.light.bg)}"`)
  .replace(/(<meta property="og:site_name" content=")[^"]*"/, `$1${escAttr(B.name)}"`)
  .replace(/(<meta (?:property="og|name="twitter):title" content=")[^"]*"/g, `$1${escAttr(B.shareTitle ?? B.name)}"`)
  .replace(/(<meta (?:property="og|name="twitter):description" content=")[^"]*"/g, `$1${escAttr(B.description)}"`)
  .replace(/(<meta property="og:url" content=")[^"]*"/, `$1${escAttr(B.siteUrl)}"`)
  .replace(/(<link rel="canonical" href=")[^"]*"/, `$1${escAttr(B.siteUrl)}"`)
  .replace(/(<meta (?:property="og|name="twitter):image" content=")[^"]*"/g, `$1${escAttr(new URL("og.png", B.siteUrl).href)}"`)
  .replace(/(<meta property="og:image:alt" content=")[^"]*"/, `$1${escAttr(`${B.name}: the app on a phone and the tagline`)}"`);
writeFileSync(`${web}index.html`, html);
console.log("Wrote manifest.webmanifest and index.html");

const pw = process.env.PLAYWRIGHT_MODULE;
if (!pw) { console.log("Set PLAYWRIGHT_MODULE (and CHROME_PATH) to also redraw the PNG icons."); process.exit(0); }
const { chromium } = await import(pathToFileURL(pw).href);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
const markUrl = `data:image/svg+xml;base64,${readFileSync(`${web}icons/mark.svg`).toString("base64")}`;
const icon = (size, pad) => `<html><body style="margin:0"><div style="width:${size}px;height:${size}px;display:grid;place-items:center;
  background:radial-gradient(circle at 30% 20%, ${B.light.sea}, ${B.light.bg} 70%)"><img src="${markUrl}" style="width:${size - 2 * pad}px;height:${size - 2 * pad}px"></div></body></html>`;
for (const [name, size, pad] of [["favicon-32.png", 32, 1], ["icon-180.png", 180, 20], ["icon-192.png", 192, 22], ["icon-512.png", 512, 58], ["icon-maskable-512.png", 512, 120]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(icon(size, pad));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${web}icons/${name}` });
  await page.close();
  console.log(`Drew icons/${name}`);
}
await browser.close();
