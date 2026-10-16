// Browser smoke test, one check per flow, against the static (GitHub Pages) build of send21 pair or
// a white-label app built on it (dewby). No server needed. Dev tool (needs Chrome + playwright-core):
//
//   PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs CHROME_PATH=/usr/bin/google-chrome \
//     node scripts/smoke-browser.js https://send21io.github.io/send21-examples/pair/
//
// Optional: AXE_PATH=/path/to/axe-core/axe.min.js also runs axe on every screen (0 violations expected).
import { readFileSync } from "node:fs";

const pw = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const { chromium } = pw.default ?? pw;
const base = process.argv[2] ?? "http://127.0.0.1:18790/send21-examples/pair/";
const AXE = process.env.AXE_PATH ? readFileSync(process.env.AXE_PATH, "utf8") : null;
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--no-sandbox"] });
const errors = [];
let passed = 0;
const ok = (name) => { passed++; console.log(`ok ${passed} - ${name}`); };
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const ctx = (locale) => b.newContext({ bypassCSP: Boolean(AXE), permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale, colorScheme: "light" });
const watch = (p, n) => {
  p.on("pageerror", (e) => errors.push(`${n}: ${e.message}`));
  p.on("console", (m) => m.type() === "error" && errors.push(`${n}: ${m.text()}`));
  p.on("dialog", (d) => { p.lastPrompt = d.defaultValue(); d.accept(); });
  return p;
};
async function axe(p, where) {
  if (!AXE) return;
  await p.waitForTimeout(500); // let the entry animation finish
  await p.addScriptTag({ content: AXE });
  const v = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((x) => `${x.id}: ${x.nodes.length}`));
  must(!v.length, `axe on ${where}: ${v.join(", ")}`);
}
const cA = await ctx("sv-SE"), cS = await ctx("de-DE"), cG = await ctx("en-US");
const A = watch(await cA.newPage(), "A"), S = watch(await cS.newPage(), "S"), G = watch(await cG.newPage(), "guest");
const home = async (p) => { await p.goto(base + "#/"); await p.waitForSelector(".contacts"); };
const signup = async (p, n) => { await p.goto(base); await p.click("[data-act=skip]"); await p.fill("input[name=name]", n); await p.click("button[type=submit]"); await p.waitForSelector(".contacts"); };
const newRequest = async (amt, note) => {
  await A.goto(base + "#/new?mode=request"); await A.waitForSelector("#amt");
  await A.click("[data-act=pick]"); await A.fill("#amt", String(amt)); if (note) await A.fill("input[name=note]", note);
  await A.click("#go"); await A.waitForSelector("[data-act=share][data-url]");
  return A.locator("[data-act=share][data-url]").first().getAttribute("data-url");
};

try {
  // 1. onboarding: three icon screens at most, skip works
  await A.goto(base); await A.waitForSelector(".slide");
  const slides = await A.locator(".dots button").count();
  must(slides >= 1 && slides <= 3, `onboarding has ${slides} screens`);
  await axe(A, "onboarding");
  ok(`onboarding (${slides} screens)`);

  // 2. setup + home empty state
  await A.click("[data-act=skip]"); await A.fill("input[name=name]", "Alex"); await A.click("button[type=submit]"); await A.waitForSelector(".contacts");
  must(await A.locator(".empty").count() > 0, "home shows an empty state");
  await axe(A, "home (empty)");
  ok("setup and empty home");

  // 3. pairing both ways by link
  await signup(S, "Sam");
  await A.goto(base + "#/me"); await A.waitForSelector(".linkbox", { state: "attached" });
  const aLink = (await A.locator(".linkbox").textContent()).trim();
  await S.goto(aLink); await S.click("button:has-text('Add Alex')"); await S.waitForTimeout(400);
  await S.goto(base + "#/me"); await S.waitForSelector(".linkbox", { state: "attached" });
  const sLink = (await S.locator(".linkbox").textContent()).trim();
  await A.goto(sLink); await A.click("button:has-text('Add Sam')"); await A.waitForTimeout(400);
  await home(A); must(await A.locator(".contact").count() >= 1, "Sam is a contact");
  ok("pairing by link, both ways");

  // 4. amount field: typing junk leaves only digits and one separator; decimals capped
  await A.goto(base + "#/new?mode=request"); await A.waitForSelector("#amt");
  await A.locator("#amt").pressSequentially("1e3-4.567");
  const typed = await A.inputValue("#amt");
  must(/^\d{1,5}([.,]\d{0,2})?$/.test(typed), `amount field shows "${typed}"`);
  ok(`amount input filtered ("1e3-4.567" -> "${typed}")`);

  // 5. request + double-submit guard: a double tap creates one request
  await A.click("[data-act=pick]"); await A.fill("#amt", "120"); await A.fill("input[name=note]", "Pizza");
  await A.locator("#go").dblclick();
  await A.waitForSelector("[data-act=share][data-url]");
  const url = await A.locator("[data-act=share][data-url]").first().getAttribute("data-url");
  await home(A);
  const pizzas = await A.locator(".activity li:has-text('Pizza')").count();
  must(pizzas === 1, `double tap made ${pizzas} requests`);
  ok("request sent once on a double tap");

  // 6. guest pays without the app: wallet link, readable address, status word
  await G.goto(url); await G.waitForSelector("text=Open wallet");
  const href = await G.locator("a:has-text('Open wallet')").getAttribute("href");
  must(/^(solana|bitcoin|ethereum):/.test(href), `wallet link ${href}`);
  must(await G.locator(".addr .edge4").count() === 2, "first and last four characters are highlighted");
  must(await G.locator(".pill:has-text('To pay')").count() === 1, "status word To pay");
  await axe(G, "pay (guest)");
  ok("pay link opens for a guest (wallet link, address check, To pay)");

  // 7. simulated payment -> Paid, tx shown; receipt marks it paid for the receiver
  await S.goto(url); await S.waitForSelector("text=Open wallet");
  await S.click("button:has-text('Simulate payment')");
  await S.waitForSelector(".pill.paid", { timeout: 8000 });
  must(await S.locator("text=Tx").count() > 0, "tx id shown once paid");
  await axe(S, "paid");
  S.lastPrompt = null; await S.click("button:has-text('the receipt')"); await S.waitForTimeout(300);
  const receipt = S.lastPrompt ?? await S.evaluate(() => navigator.clipboard.readText());
  await A.goto(receipt); await A.waitForSelector("text=paid you");
  await home(A); must(await A.locator(".activity .status.paid").count() >= 1, "Paid on the receiver's home");
  ok("simulated payment: Paid for both, with tx id and receipt");

  // 8. amount mismatch
  const u2 = await newRequest(50, "Taxi");
  await S.goto(u2); await S.waitForSelector("text=Open wallet");
  if (await S.locator("details.more").count()) await S.click("details.more summary");
  await S.click("[data-act=simBad]"); await S.waitForSelector(".pill.review", { timeout: 8000 });
  must(await S.locator(".pill.review:has-text('Mismatch')").count() === 1, "Mismatch word");
  must(await S.locator("a:has-text('Open wallet')").count() === 0, "no Open wallet while the amount is checked");
  await axe(S, "mismatch");
  ok("amount mismatch is shown, not paid");

  // 9. cancel, then a payment after close
  await newRequest(30, "Coffee");
  await home(A); await A.click(".activity li a >> nth=0"); await A.waitForSelector("[data-act=cancel]");
  // The in-app sheet: focus starts on "Keep it", Tab stays inside, Esc keeps the request.
  await A.click("[data-act=cancel]"); await A.waitForSelector(".sheet[role=dialog][aria-modal=true]");
  await A.waitForTimeout(300);
  must(await A.evaluate(() => document.activeElement?.matches("[data-sheet-no]")), "focus starts on the safe button");
  for (let i = 0; i < 5; i++) await A.keyboard.press("Tab");
  must(await A.evaluate(() => Boolean(document.activeElement?.closest(".sheet"))), "focus is trapped in the sheet");
  must(await A.evaluate(() => document.getElementById("app").inert), "the page behind is inert");
  await axe(A, "cancel sheet");
  await A.keyboard.press("Escape"); await A.waitForSelector(".sheet", { state: "detached" });
  must(await A.locator("[data-act=cancel]").count() === 1, "Esc keeps the request");
  must(await A.evaluate(() => document.activeElement?.matches("[data-act=cancel]")), "focus returns to Cancel");
  await A.click("[data-act=cancel]"); await A.click("[data-sheet-yes]"); await A.waitForSelector(".contacts");
  await A.click(".activity li a >> nth=0"); await A.waitForSelector(".pill.cancelled");
  must(await A.locator("[data-act=cancel]").count() === 0, "a cancelled request can't be cancelled again");
  await A.click("[data-act=simLate]"); await A.waitForSelector(".late");
  must(await A.locator(".late:has-text('Payment after close')").count() === 1, "notice shown");
  must(await A.locator(".late:has-text('cancelled')").count() === 1, "notice names the closed state");
  must(await A.locator(".pill.cancelled").count() === 1, "request stays cancelled");
  await axe(A, "payment after close");
  ok("cancel sheet (focus trap, Esc keeps it); cancelled stays cancelled; payment after close shows txId and state");

  // 10. expired: no way to pay
  const u3 = await newRequest(15, "Snacks");
  await S.goto(u3); await S.waitForSelector("text=Open wallet");
  await S.click("details.more summary"); await S.click("[data-act=simExpire]"); await S.waitForSelector(".pill.expired");
  must(await S.locator("a:has-text('Open wallet')").count() === 0, "expired requests have no wallet link");
  ok("expired request can't be paid");

  // 11. history + filters
  await A.goto(base + "#/history"); await A.waitForSelector("[data-act=filter]");
  await A.click("[data-act=filter][data-f=paid]"); await A.waitForTimeout(300);
  const rows = await A.locator(".activity li").count(), paidRows = await A.locator(".activity li:has(.status.paid)").count();
  must(rows >= 1 && rows === paidRows, `paid filter shows ${paidRows}/${rows}`);
  await axe(A, "history");
  ok("history with filters");

  // 12. names are text, never markup
  const X = watch(await (await ctx("en-GB")).newPage(), "xss");
  await X.goto(base); await X.click("[data-act=skip]");
  await X.fill("input[name=name]", "<img src=x onerror=window.__x=1>\u202E"); await X.click("button[type=submit]"); await X.waitForSelector(".contacts");
  must(await X.locator("main img[src=x]").count() === 0 && !(await X.evaluate(() => window.__x)), "markup in a name was rendered");
  errors.splice(0, errors.length, ...errors.filter((e) => !e.startsWith("xss:") || !/net::ERR|404/.test(e)));
  ok("a name with markup stays text");

  // 13. a broken link explains itself
  await A.goto(base + "#/r/not-a-real-link"); await A.waitForSelector("main h1");
  must(/link/i.test(await A.locator("main h1").textContent()), "bad link screen");
  await axe(A, "bad link");
  ok("broken link screen");

  // 14. offline: the app shell still opens and says so
  await home(A); await A.waitForTimeout(800); await cA.setOffline(true); await A.reload().catch(() => {}); await A.waitForSelector(".contacts", { timeout: 8000 });
  must(await A.locator(".testnet .offline:not([hidden])").count() === 1, "offline chip");
  await cA.setOffline(false);
  ok("offline: app opens from the cache and shows Offline");

  // 15. forced-dark preview palette
  const F = watch(await (await ctx("sv-SE")).newPage(), "fd");
  await F.goto(base + "?fd"); await F.waitForSelector(".slide");
  must(await F.evaluate(() => document.documentElement.classList.contains("fd")), "?fd palette");
  await axe(F, "onboarding (?fd)");
  ok("forced-dark palette (?fd)");

  const real = errors.filter((e) => !/Failed to load resource.*(net::ERR_INTERNET_DISCONNECTED|ERR_INTERNET_DISCONNECTED)/.test(e));
  must(!real.length, `console errors:\n${real.join("\n")}`);
  ok("zero console errors");
  console.log(`# pass ${passed}`);
} catch (e) {
  console.log(`not ok ${passed + 1} - ${e.message}`);
  process.exitCode = 1;
} finally {
  await b.close();
}
