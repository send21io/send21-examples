// Renders the README screenshots with headless Chrome at a 390x844 phone viewport by walking
// through the mock flow with three users, then an overview strip. Dev tool, not a dependency:
//
//   npm i --no-save playwright-core       (or set PLAYWRIGHT_MODULE)
//   CHROME_PATH=/usr/bin/google-chrome npm run screenshots
//
// It starts its own mock server (the shared send21-pair server with dewby's UI) on a free port.
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { loadBrand } from "../server/brand.js";

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const { chromium } = pw.default ?? pw;
const OUT = process.env.OUT ?? new URL("../screenshots/", import.meta.url).pathname;
const B = loadBrand();

const app = createApp({ mode: "mock", dbFile: join(mkdtempSync(join(tmpdir(), "dewby-")), "db.sqlite"), push: false, simulateDelayMs: 800, log: () => {} });
const server = createServer(app.handler);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const phone = (locale, b = browser, colorScheme = "light") => b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale, colorScheme });
const shot = async (page, name, wait = 900, keepToast = false) => { await page.waitForTimeout(wait); if (!keepToast) await page.evaluate(() => document.getElementById("toast")?.classList.remove("show")); await page.waitForTimeout(keepToast ? 0 : 400); await page.screenshot({ path: join(OUT, name) }); console.log("saved", name); };
const errors = [];
const watch = (p, who) => { p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`)); p.on("console", (m) => m.type() === "error" && errors.push(`${who}: ${m.text()}`)); };

async function signup(page, name, url = base + "/") {
  await page.goto(url);
  await page.click("[data-act=skip]");
  await page.fill("input[name=name]", name);
  await page.click("button[type=submit]");
  await page.waitForSelector(".bubble");
}

const alex = await (await phone("sv-SE")).newPage(); watch(alex, "alex");
const sam = await (await phone("de-DE")).newPage(); watch(sam, "sam");
const kim = await (await phone("en-GB")).newPage(); watch(kim, "kim");

// Onboarding: three cards, then a name.
await alex.goto(base + "/");
await alex.waitForSelector(".slide");
await shot(alex, "01-onboarding.png");
await alex.click("#next"); await alex.waitForTimeout(500);
await alex.click("#next"); await alex.waitForTimeout(500);
await alex.click("#next");
await alex.fill("input[name=name]", "Alex");
await shot(alex, "02-start.png");
await alex.click("button[type=submit]");
await alex.waitForSelector(".bubble");
await shot(alex, "03-home-empty.png");

await alex.click("a.btn:has-text('My code')");
await alex.waitForSelector("main .qr svg");
await shot(alex, "04-my-code.png");
const pairUrl = await alex.locator(".linkbox").textContent();

await signup(sam, "Sam");
await sam.goto(pairUrl);
await sam.waitForSelector("text=Add Alex");
await shot(sam, "05-add-friend.png");
await sam.click("button:has-text('Add Alex')");
await sam.waitForSelector(".bubble");

await signup(kim, "Kim");
await kim.goto(pairUrl);
await kim.click("button:has-text('Add Alex')");
await kim.waitForSelector(".bubble");

// Alex asks Sam for 120 SEK.
await alex.goto(base + "/#/");
await alex.waitForSelector(".contact >> text=Sam");
await alex.click(".contact >> text=Sam");
await alex.fill("#amt", "120");
await alex.fill("input[name=note]", "Pizza");
await shot(alex, "06-request.png");
await alex.click("#go");
await alex.waitForSelector("text=Request sent");

// Sam sees it and opens the pay screen.
await sam.goto(base + "/#/");
await sam.waitForSelector("ul.activity .status.awaiting");
await sam.click("ul.activity a");
await sam.waitForSelector("text=Open wallet");
await shot(sam, "07-pay.png");
await sam.click("button:has-text('Simulate payment')");
await sam.waitForSelector(".pill.paid", { timeout: 10000 });
await shot(sam, "08-paid.png", 1300, true);

// Split dinner between Alex, Sam and Kim.
await alex.goto(base + "/#/");
await alex.click(".tile:has-text('Split')");
await alex.click(".contact >> text=Sam");
await alex.click(".contact >> text=Kim");
await alex.fill("#amt", "690");
await alex.fill("input[name=note]", "Dinner");
await shot(alex, "09-split.png");
await alex.click("#go");
await alex.waitForSelector("text=Split sent");
await kim.goto(base + "/#/");
await kim.click("ul.activity a");
await kim.click("button:has-text('Simulate payment')");
await kim.waitForSelector(".pill.paid", { timeout: 10000 });
await alex.waitForSelector(".status.paid", { timeout: 10000 });
await shot(alex, "10-split-sent.png");

await alex.goto(base + "/#/");
await alex.waitForSelector(".status.paid");
await shot(alex, "11-home.png");

// Pay screen in Pay mode, and a QR anyone can pay.
await alex.goto(base + "/#/new?mode=pay");
await alex.click(".contact >> text=Kim");
await alex.fill("#amt", "85");
await alex.fill("input[name=note]", "Coffee");
await shot(alex, "12-pay-friend.png");
await alex.goto(base + "/#/new?mode=link");
await alex.fill("#amt", "45");
await alex.fill("input[name=note]", "Lemonade");
await alex.click("#go");
await alex.waitForSelector("text=Scan to pay");
await shot(alex, "13-qr-anyone.png");
await alex.goto(base + "/#/settings");
await alex.waitForSelector(".about");
await alex.evaluate(() => document.querySelector(".about").scrollIntoView({ block: "center" }));
await alex.waitForTimeout(300);
await alex.screenshot({ path: join(OUT, "14-settings-about.png") }); console.log("saved 14-settings-about.png");

// Optional dark theme, and desktop.
await alex.goto(base + "/#/");
await alex.evaluate((k) => localStorage.setItem(k, "dark"), `${B.storagePrefix}.theme`);
await alex.reload(); await alex.waitForSelector(".bubble");
await shot(alex, "15-dark.png");
await alex.evaluate((k) => localStorage.setItem(k, "light"), `${B.storagePrefix}.theme`);
const desk = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "sv-SE", storageState: await alex.context().storageState() })).newPage(); watch(desk, "desk");
await desk.goto(base + "/#/");
await desk.waitForSelector(".bubble");
await shot(desk, "16-desktop.png");

const fresh = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-GB" })).newPage(); watch(fresh, "desk-first");
await fresh.goto(base + "/");
await fresh.waitForSelector(".slide");
await shot(fresh, "23-desktop-first-run.png");

// One person, one phone: the demo friend walks the whole loop (request, the friend pays, paid).
{
  const solo = await (await phone("en-GB")).newPage(); watch(solo, "solo");
  await solo.goto(base + "/");
  await solo.click("[data-act=tryDemo]");
  await solo.fill("input[name=name]", "Robin");
  await solo.click("button[type=submit]");
  await solo.waitForSelector("#amt");
  await shot(solo, "20-demo-request.png");
  await solo.click("#go");
  await solo.waitForSelector("[data-act=demoPay]");
  await shot(solo, "21-demo-sent.png");
  await solo.click("[data-act=demoPay]");
  await solo.waitForSelector(".pill.paid", { timeout: 15000 });
  await shot(solo, "22-demo-paid.png", 1300, true);
}

// Forced dark (Samsung Internet's default): Chrome's forceDarkModeEnabled is the closest emulation.
// The app must detect it and switch to its forced-dark palette. ?fd previews the same palette.
{
  const fdBrowser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox", "--blink-settings=forceDarkModeEnabled=true"] });
  const fd = await (await phone("sv-SE", fdBrowser)).newPage(); watch(fd, "forced-dark");
  await signup(fd, "Jo");
  if (!(await fd.evaluate(() => document.documentElement.classList.contains("fd")))) errors.push("forced dark was not detected");
  await shot(fd, "17-home-empty-forced-dark.png");
  await fd.click("a.btn:has-text('My code')");
  await fd.waitForSelector("main .qr img");
  await shot(fd, "18-my-code-forced-dark.png");
  await fdBrowser.close();
  const pv = await (await phone("sv-SE")).newPage(); watch(pv, "fd-preview");
  await pv.goto(base + "/?fd");
  await pv.waitForSelector(".slide");
  await shot(pv, "19-onboarding-fd-preview.png");
}

// Overview strip at the phone viewport.
const strip = ["01-onboarding.png", "03-home-empty.png", "11-home.png", "07-pay.png", "08-paid.png", "09-split.png", "10-split-sent.png", "04-my-code.png"];
const imgs = strip.map((f) => `<img src="data:image/png;base64,${readFileSync(join(OUT, f)).toString("base64")}">`).join("");
const ov = await browser.newPage({ viewport: { width: 390 * strip.length + 24 * (strip.length + 1), height: 844 + 48 }, deviceScaleFactor: 1 });
await ov.setContent(`<html><body style="margin:0;background:linear-gradient(135deg,${B.light.sea},${B.light.bg} 45%,${B.light.lime});display:flex;gap:24px;padding:24px;box-sizing:border-box">${imgs.replace(/<img /g, '<img style="width:390px;height:844px;border-radius:30px;box-shadow:0 18px 40px rgba(13,43,38,.22)" ')}</body></html>`);
await ov.waitForTimeout(300);
await ov.screenshot({ path: join(OUT, "overview.png") });
console.log("saved overview.png");

if (errors.length) { console.log("PAGE ERRORS:\n" + errors.join("\n")); process.exitCode = 1; }
await browser.close();
server.close();
app.close();
