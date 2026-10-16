// Draws web/og.png (1200x630 share card) and web/shots/*.png (manifest screenshots) from the
// brand and from screenshots/ (run npm run screenshots first). Needs Chrome + playwright-core:
//   PLAYWRIGHT_MODULE=... CHROME_PATH=/usr/bin/google-chrome npm run og
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBrand } from "../server/brand.js";

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const { chromium } = pw.default ?? pw;
const B = loadBrand();
const web = fileURLToPath(new URL("../web/", import.meta.url));
const shots = fileURLToPath(new URL("../screenshots/", import.meta.url));
const data = (f, type = "image/png") => `data:${type};base64,${readFileSync(f).toString("base64")}`;
const L = B.light;
const wm = readFileSync(`${web}icons/wordmark.svg`, "utf8");
const font = data(`${web}fonts/nunito-latin.woff2`, "font/woff2");

const html = `<html><head><style>
@font-face { font-family: N; font-weight: 600 900; src: url(${font}) format("woff2"); }
body { margin: 0; width: 1200px; height: 630px; overflow: hidden; font-family: N, sans-serif; color: ${L.ink};
  background: radial-gradient(60% 80% at 100% 0%, ${L.lime}, transparent 60%), radial-gradient(60% 70% at 0% 100%, ${L.sea}, transparent 65%), ${L.bg}; }
.l { position: absolute; left: 68px; top: 96px; width: 560px; }
.brand { display: flex; align-items: center; gap: 18px; } .brand img { width: 96px; } .brand .w { width: 230px; }
h1 { font-size: 62px; line-height: 1; letter-spacing: -.035em; font-weight: 900; margin: 40px 0 22px; }
p { font-size: 30px; font-weight: 700; margin: 0; color: ${L.muted}; }
.chips { display: flex; gap: 12px; margin-top: 34px; }
.chips span { font-size: 24px; font-weight: 900; padding: 10px 20px; border-radius: 999px; border: 3px solid ${L.ink}; }
.ph { position: absolute; width: 280px; border-radius: 40px; border: 9px solid ${L.ink}; box-shadow: 0 24px 50px rgba(13,43,38,.25); }
.p1 { right: 250px; top: 80px; transform: rotate(-5deg); } .p2 { right: 40px; top: 120px; transform: rotate(6deg); }
.tag { position: absolute; right: 60px; top: 44px; background: ${L.lime}; border: 3px solid ${L.ink}; border-radius: 999px; padding: 6px 16px; font-weight: 900; font-size: 22px; transform: rotate(5deg); box-shadow: 3px 4px 0 ${L.ink}; }
</style></head><body>
<div class="l"><div class="brand"><img src="${data(`${web}icons/mark.svg`, "image/svg+xml")}"><img class="w" src="data:image/svg+xml;base64,${Buffer.from(wm).toString("base64")}"></div>
<h1>Pay friends back. Split the bill.</h1><p>Ask, pay, split or show a QR. Your own wallet signs.</p>
<div class="chips"><span style="background:${L.mint}">Request</span><span style="background:${L.pop}">Pay</span><span style="background:${L.lime}">Split</span><span style="background:${L.sea}">QR</span></div></div>
<img class="ph p1" src="${data(`${shots}11-home.png`)}"><img class="ph p2" src="${data(`${shots}08-paid.png`)}">
<div class="tag">test mode</div>
</body></html>`;

const b = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await p.setContent(html);
await p.waitForTimeout(400);
await p.screenshot({ path: `${web}og.png` });
await b.close();
mkdirSync(`${web}shots`, { recursive: true });
copyFileSync(`${shots}11-home.png`, `${web}shots/home.png`);
copyFileSync(`${shots}08-paid.png`, `${web}shots/paid.png`);
copyFileSync(`${shots}16-desktop.png`, `${web}shots/desktop.png`);
console.log("Wrote web/og.png and web/shots/");
