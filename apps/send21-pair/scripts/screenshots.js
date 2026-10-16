// Renders the README screenshots with headless Chrome at a 390x844 phone
// viewport by walking through the mock flow with three users, then an
// overview strip. Dev tool, not a dependency:
//
//   npm i --no-save playwright-core       (or set PLAYWRIGHT_MODULE)
//   CHROME_PATH=/usr/bin/google-chrome npm run screenshots
//
// It starts its own mock server on a free port with a throwaway database.
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const { chromium } = pw.default ?? pw;
const OUT = process.env.OUT ?? new URL("../screenshots/", import.meta.url).pathname;

const app = createApp({ mode: "mock", dbFile: join(mkdtempSync(join(tmpdir(), "pair-")), "db.sqlite"), push: false, simulateDelayMs: 800, log: () => {} });
const server = createServer(app.handler);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const phone = (locale) => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale, colorScheme: "dark" });
const shot = async (page, name, wait = 800, keepToast = false) => { await page.waitForTimeout(wait); if (!keepToast) await page.evaluate(() => document.getElementById("toast")?.classList.remove("show")); await page.waitForTimeout(keepToast ? 0 : 350); await page.screenshot({ path: join(OUT, name) }); console.log("saved", name); };
const errors = [];
const watch = (p, who) => { p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`)); p.on("console", (m) => m.type() === "error" && errors.push(`${who}: ${m.text()}`)); };

async function signup(page, name) {
  await page.goto(base + "/");
  await page.click("[data-act=skip]");
  await page.fill("input[name=name]", name);
  await page.click("button[type=submit]");
  await page.waitForSelector(".hero");
}

const alex = await (await phone("sv-SE")).newPage(); watch(alex, "alex");
const sam = await (await phone("de-DE")).newPage(); watch(sam, "sam");
const kim = await (await phone("en-GB")).newPage(); watch(kim, "kim");

// Onboarding: three swipeable cards, then a name.
await alex.goto(base + "/");
await alex.waitForSelector(".slide");
await shot(alex, "01-onboarding.png");
await alex.click("#next"); await alex.waitForTimeout(500);
await alex.click("#next"); await alex.waitForTimeout(500);
await alex.click("#next");
await alex.fill("input[name=name]", "Alex");
await shot(alex, "02-start.png");
await alex.click("button[type=submit]");
await alex.waitForSelector(".hero");
await shot(alex, "15-home-empty.png");

await alex.click("a.btn:has-text('Show my code')");
await alex.waitForSelector(".qr svg");
await shot(alex, "03-my-code.png");
const pairUrl = await alex.locator(".linkbox").textContent();

await signup(sam, "Sam");
await sam.goto(pairUrl);
await sam.waitForSelector("text=Add Alex");
await shot(sam, "04-add-contact.png");
await sam.click("button:has-text('Add Alex')");
await sam.waitForSelector(".hero");

await signup(kim, "Kim");
await kim.goto(pairUrl);
await kim.click("button:has-text('Add Alex')");
await kim.waitForSelector(".hero");

// Alex asks Sam for 120 SEK.
await alex.goto(base + "/#/");
await alex.waitForSelector(".contact >> text=Sam");
await alex.click(".contact >> text=Sam");
await alex.fill("#amt", "120");
await alex.fill("input[name=note]", "Pizza");
await shot(alex, "05-request.png");
await alex.click("#go");
await alex.waitForSelector("text=Request sent");

// Sam sees it and opens the pay screen (what the notification tap opens).
await sam.goto(base + "/#/");
await sam.waitForSelector("ul.activity .status.awaiting");
await shot(sam, "06-home-asked.png");
await sam.click("ul.activity a");
await sam.waitForSelector("text=Open wallet");
await shot(sam, "07-pay.png");
await sam.click("button:has-text('Simulate payment')");
await sam.waitForSelector(".pill.paid", { timeout: 10000 });
await shot(sam, "08-paid.png", 500, true);

await alex.goto(base + "/#/");
await alex.waitForSelector(".status.paid");
await shot(alex, "09-home-paid.png");

// Split dinner between Alex, Sam and Kim.
await alex.click(".action:has-text('Split')");
await alex.click(".contact >> text=Sam");
await alex.click(".contact >> text=Kim");
await alex.fill("#amt", "690");
await alex.fill("input[name=note]", "Dinner");
await shot(alex, "10-split.png");
await alex.click("#go");
await alex.waitForSelector("text=Split sent");
// Kim pays her share, so the ring shows progress.
await kim.goto(base + "/#/");
await kim.click("ul.activity a");
await kim.click("button:has-text('Simulate payment')");
await kim.waitForSelector(".pill.paid", { timeout: 10000 });
await alex.waitForSelector(".status.paid", { timeout: 10000 });
await shot(alex, "11-split-sent.png");

// A QR anyone can pay (market stall).
await alex.goto(base + "/#/new?mode=link");
await alex.fill("#amt", "45");
await alex.fill("input[name=note]", "Honey jar");
await alex.click("#go");
await alex.waitForSelector("text=Scan to pay");
await shot(alex, "12-qr-anyone.png");

// Light mode, and desktop.
await alex.goto(base + "/#/history");
await alex.waitForSelector("[data-act=filter]");
await shot(alex, "18-history.png");
// Light mode lives in Settings.
await alex.goto(base + "/#/settings");
await alex.click("[data-act=theme]");
await alex.waitForSelector("html[data-theme=light]");
await alex.goto(base + "/#/");
await alex.waitForSelector(".hero");
await shot(alex, "13-light.png");
await alex.goto(base + "/#/settings");
await alex.click("[data-act=theme]");
await alex.waitForSelector("html[data-theme=dark]");
const desk = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "sv-SE", colorScheme: "dark", storageState: await alex.context().storageState() })).newPage(); watch(desk, "desk");
await desk.goto(base + "/#/");
await desk.waitForSelector(".hero");
await shot(desk, "14-desktop.png");

// Samsung Internet's default dark mode (WebView FORCE_DARK_ONLY) repaints pages and ignores
// color-scheme. Chrome's forceDarkModeEnabled setting is the closest emulation: the app must detect it
// and switch to its forced-dark palette (dark fills, orange text/icons/SVG strokes, QR as image).
{
  const fdBrowser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox", "--blink-settings=forceDarkModeEnabled=true"] });
  const fd = await (await fdBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "sv-SE", colorScheme: "light" })).newPage(); watch(fd, "forced-dark");
  await signup(fd, "Jo");
  if (!(await fd.evaluate(() => document.documentElement.classList.contains("fd")))) errors.push("forced dark was not detected");
  await shot(fd, "16-home-empty-forced-dark.png");
  await fd.click("a.btn:has-text('Show my code')");
  await fd.waitForSelector(".qr img");
  await shot(fd, "17-my-code-forced-dark.png");
  await fdBrowser.close();
}

// Overview strip at the phone viewport.
const strip = ["01-onboarding.png", "09-home-paid.png", "05-request.png", "07-pay.png", "08-paid.png", "11-split-sent.png", "03-my-code.png"];
const imgs = strip.map((f) => `<img src="data:image/png;base64,${readFileSync(join(OUT, f)).toString("base64")}">`).join("");
const ov = await browser.newPage({ viewport: { width: 390 * strip.length + 24 * (strip.length + 1), height: 844 + 48 }, deviceScaleFactor: 1 });
await ov.setContent(`<html><body style="margin:0;background:linear-gradient(135deg,#1B1C20,#2A1A08 55%,#1B1C20);display:flex;gap:24px;padding:24px;box-sizing:border-box">${imgs.replace(/<img /g, '<img style="width:390px;height:844px;border-radius:28px;box-shadow:0 20px 50px rgba(0,0,0,.5)" ')}</body></html>`);
await ov.waitForTimeout(300);
await ov.screenshot({ path: join(OUT, "overview.png") });
console.log("saved overview.png");

if (errors.length) { console.log("PAGE ERRORS:\n" + errors.join("\n")); process.exitCode = 1; }
await browser.close();
server.close();
app.close();
