// Renders the README screenshots with headless Chrome at a phone viewport, by
// walking through the mock flow with three users. Dev tool, not a dependency:
//
//   npm i --no-save playwright-core       (or set PLAYWRIGHT_MODULE)
//   CHROME_PATH=/usr/bin/google-chrome npm run screenshots
//
// It starts its own mock server on a free port with a throwaway database.
import { mkdtempSync } from "node:fs";
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
const shot = async (page, name) => { await page.waitForTimeout(250); await page.screenshot({ path: join(OUT, name) }); console.log("saved", name); };

async function signup(page, name) {
  await page.goto(base + "/");
  await page.fill("input[name=name]", name);
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Request");
}

const alex = await (await phone("sv-SE")).newPage();
const sam = await (await phone("de-DE")).newPage();
const kim = await (await phone("en-GB")).newPage();

await alex.goto(base + "/");
await alex.fill("input[name=name]", "Alex");
await shot(alex, "01-start.png");
await alex.click("button[type=submit]");
await alex.waitForSelector("text=Start by adding someone");

await alex.click("text=Show my code");
await alex.waitForSelector(".qr svg");
await shot(alex, "02-my-code.png");
const pairUrl = await alex.locator(".linkbox").textContent();

await signup(sam, "Sam");
await sam.goto(pairUrl);
await sam.waitForSelector("text=Add Alex");
await shot(sam, "03-add-contact.png");
await sam.click("button:has-text('Add Alex')");
await sam.waitForSelector("text=Activity");

await signup(kim, "Kim");
await kim.goto(pairUrl);
await kim.click("button:has-text('Add Alex')");
await kim.waitForSelector("text=Activity");

// Alex asks Sam for 120 SEK.
await alex.goto(base + "/#/");
await alex.waitForSelector(".contact >> text=Sam");
await alex.click(".contact >> text=Sam");
await alex.fill("#amt", "120");
await alex.fill("input[name=note]", "Pizza");
await shot(alex, "04-request.png");
await alex.click("#go");
await alex.waitForSelector("text=Request sent");

// Sam sees it and opens the pay screen (what the notification tap opens).
await sam.goto(base + "/#/");
await sam.waitForSelector("text=Alex is waiting for you");
await shot(sam, "05-home-asked.png");
await sam.click("ul.activity a");
await sam.waitForSelector("text=Open wallet");
await shot(sam, "06-pay.png");
await sam.click("button:has-text('Simulate payment')");
await sam.waitForSelector(".pill.paid", { timeout: 10000 });
await shot(sam, "07-paid.png");

await alex.goto(base + "/#/");
await alex.waitForSelector(".status.paid");
await shot(alex, "08-home-paid.png");

// Split dinner between Alex, Sam and Kim.
await alex.click("a:has-text('Request')");
await alex.click(".contact >> text=Sam");
await alex.click(".contact >> text=Kim");
await alex.fill("#amt", "690");
await alex.fill("input[name=note]", "Dinner");
await shot(alex, "09-split.png");
await alex.click("#go");
await alex.waitForSelector("text=Request sent");
await shot(alex, "10-split-sent.png");

// A QR anyone can pay (market stall).
await alex.goto(base + "/#/new?mode=link");
await alex.fill("#amt", "45");
await alex.fill("input[name=note]", "Honey jar");
await alex.click("#go");
await alex.waitForSelector("text=Show this to the person paying");
await shot(alex, "11-qr-anyone.png");

await browser.close();
server.close();
app.close();
