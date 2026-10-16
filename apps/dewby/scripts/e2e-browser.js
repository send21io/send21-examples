// Browser-only flow against the static (GitHub Pages) build, no server: onboarding, pair both ways
// by link, request, a guest without the app opens the pay link, simulated payment, receipt link,
// Paid on both homes, then the forced-dark palette. Dev tool (needs Chrome + playwright-core):
//
//   PLAYWRIGHT_MODULE=... CHROME_PATH=/usr/bin/google-chrome node scripts/e2e-browser.js https://send21io.github.io/send21-examples/dewby/
const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const { chromium } = pw.default ?? pw;
const base = process.argv[2] ?? "http://127.0.0.1:18790/send21-examples/dewby/";
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const ctx = (locale) => b.newContext({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale, colorScheme: "light" });
const errors = [];
const alex = await (await ctx("sv-SE")).newPage();
const sam = await (await ctx("de-DE")).newPage();
const guest = await (await ctx("en-US")).newPage();
for (const [p, n] of [[alex, "alex"], [sam, "sam"], [guest, "guest"]]) { p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`)); p.on("console", (m) => m.type() === "error" && errors.push(`${n}: ${m.text()}`)); }
let lastPrompt = null;
for (const p of [alex, sam]) p.on("dialog", (d) => { lastPrompt = d.defaultValue(); d.accept(); });
const step = (s) => console.log("ok:", s);

async function signup(p, n) { await p.goto(base); await p.click("[data-act=skip]"); await p.fill("input[name=name]", n); await p.click("button[type=submit]"); await p.waitForSelector(".bubble"); }
await alex.goto(base);
await alex.waitForSelector(".slide >> text=Scan a friend");
if (await alex.evaluate(() => document.documentElement.dataset.theme) !== "light") throw new Error("light must be the default theme");
step("onboarding, light theme by default");
await signup(alex, "Alex"); await signup(sam, "Sam"); step("sign up");
await alex.goto(base + "#/me"); const aLink = (await alex.locator(".linkbox").textContent()).trim();
await sam.goto(aLink); await sam.click("button:has-text('Add Alex')"); await sam.waitForSelector("text=Show Alex your code");
await sam.goto(base + "#/me"); const sLink = (await sam.locator(".linkbox").textContent()).trim();
await alex.goto(sLink); await alex.click("button:has-text('Add Sam')"); step("paired both ways by link");
await alex.goto(base + "#/"); await alex.click(".contact >> text=Sam");
await alex.fill("#amt", "120"); await alex.fill("input[name=note]", "Pizza"); await alex.click("#go");
await alex.waitForSelector("text=Request sent"); step("request sent");
const reqUrl = await alex.locator("[data-act=share]").first().getAttribute("data-url");
await guest.goto(reqUrl); await guest.waitForSelector("text=Open wallet");
const memo = decodeURIComponent(await guest.locator("a:has-text('Open wallet')").getAttribute("href"));
if (!/message=dewby: Pizza/.test(memo) || /send21/.test(memo)) throw new Error(`wallet link memo: ${memo}`);
step(`guest without the app sees the pay screen (${(await guest.locator(".crypto").first().textContent()).trim()})`);
await sam.goto(reqUrl); await sam.waitForSelector("text=Open wallet");
await sam.click("button:has-text('Simulate payment')");
await sam.waitForSelector(".pill.paid", { timeout: 8000 }); await sam.waitForSelector(".splash"); step("simulated payment, success moment");
await sam.click("button:has-text('the receipt')"); await sam.waitForTimeout(300);
if (!lastPrompt) lastPrompt = await sam.evaluate(() => navigator.clipboard.readText());
await alex.goto(lastPrompt); await alex.waitForSelector("text=paid you"); step("receipt link applied");
await alex.goto(base + "#/"); await alex.waitForSelector(".status.paid");
await sam.goto(base + "#/"); await sam.waitForSelector(".status.paid"); step("Paid on both homes");
const keys = await alex.evaluate(() => Object.keys(localStorage));
if (!keys.some((k) => k.startsWith("dewby.")) || keys.some((k) => k.startsWith("pair."))) throw new Error(`storage keys: ${keys}`);
step("storage namespaced (dewby.*)");
const fd = await (await ctx("sv-SE")).newPage();
await fd.goto(base + "?fd"); await fd.waitForSelector(".slide");
if (!(await fd.evaluate(() => document.documentElement.classList.contains("fd")))) throw new Error("?fd did not switch the palette");
step("?fd forced-dark palette");
const v = await (await alex.request.get(base + "sw.js")).text();
console.log("sw cache:", v.match(/CACHE = "([^"]+)"/)?.[1]);
if (errors.length) { console.log("PAGE ERRORS:\n" + errors.join("\n")); process.exitCode = 1; } else console.log("BROWSER-ONLY FLOW OK", base);
await b.close();
