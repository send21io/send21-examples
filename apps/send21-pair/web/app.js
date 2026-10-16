import {
  ASSETS, FINAL, addressGroups, cleanText, cryptoLine, fiatForLocale, formatFiat, initials, mockBaseUnits, networkOf, parseAmount, pickAsset, randomId,
  safeHref, sanitizeAmountInput, splitShares, statusText, statusWord, timeLeft, validAddress, validColor,
} from "./lib/core.js";
import { serverApi } from "./lib/server-api.js";
import { staticApi } from "./lib/static-api.js";
import qrcode from "./vendor/qrcode.js";
import { icon } from "./icons.js";

// ---- setup ---------------------------------------------------------------
const params = new URLSearchParams(location.search);
if (params.get("as")) sessionStorage.setItem("pair.slot", params.get("as").replace(/[^a-z0-9_-]/gi, "").slice(0, 20));
const slot = sessionStorage.getItem("pair.slot") || "default";
const BOOT = window.SEND21_PAIR ?? { backend: "static", mode: "mock" };
const api = BOOT.backend === "server" ? serverApi(slot) : staticApi(slot);
const locale = navigator.language || "en-US";
const $app = document.getElementById("app");
let cfg = null;
let me = null;
let cleanup = [];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n, f) => formatFiat(n, f, locale);
const first = (name) => String(name ?? "").split(" ")[0];
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const touch = matchMedia("(pointer: coarse)").matches;
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const logo = `<img class="logo" src="icons/logo.svg" alt="send21">`;
// Forced dark (Samsung Internet's default "Force Dark Only", Android WebView): the browser repaints
// the page itself, darkening light or saturated fills (orange turns maroon) and inverting dark text, and
// it ignores color-scheme opt-outs. Detect it the documented way (a light-only probe whose Canvas
// color is not white) and switch to a palette that survives: dark fills, orange only as text, icons
// and SVG strokes, and QR codes as images.
function detectForcedDark() {
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;width:1px;height:1px;left:-9px;top:-9px;background-color:Canvas;color-scheme:light only";
  document.body.appendChild(d);
  const c = getComputedStyle(d).backgroundColor;
  d.remove();
  return !/^rgba?\(255, 255, 255/.test(c);
}
const FORCED_DARK = new URLSearchParams(location.search).has("fd") || detectForcedDark();
if (FORCED_DARK) document.documentElement.classList.add("fd");
const EDGE_SEL = ".btn.primary, .hero, .action.main .orb, .seg button[aria-pressed=true]";
function addEdges(root) {
  if (!FORCED_DARK) return;
  for (const el of root.querySelectorAll(EDGE_SEL)) {
    if (el.querySelector(":scope > .edge")) continue;
    el.insertAdjacentHTML("beforeend", '<svg class="edge" aria-hidden="true" focusable="false"><rect/></svg>');
  }
}
const BRAND = ["#F7931A", "#FFB347", "#FEF8EC", "#4ADE80", "#E8730C", "#FFD08A"];
/** A short buzz where the phone supports it (Android Chrome, Samsung Internet); silent elsewhere and under reduced motion. */
const haptic = (p = 12) => { if (!calm()) try { navigator.vibrate?.(p); } catch { /* not allowed */ } };
/** Never show a raw parser or network error: map every failure to one short, human line. */
function friendly(err) {
  if (!err) return "Something went wrong. Try again.";
  if (err.code === "bad_link" || err.name === "SyntaxError" || err.name === "InvalidCharacterError" || err.status === 404) return "This link doesn't work. Ask for a new one.";
  if (err.code === "offline" || (!navigator.onLine && err.name === "TypeError")) return "You're offline. Try again when you're back.";
  return String(err.message || "Something went wrong. Try again.").slice(0, 160);
}

// ---- small UI pieces ---------------------------------------------------------
function avatar(name, color, cls = "") {
  return `<span class="avatar ${cls}" style="background-color:${validColor(color) ? color : "#F7931A"}" aria-hidden="true">${esc(initials(name ?? "?"))}</span>`;
}
function qrImg(q, n, label) {
  const s = 8, c = document.createElement("canvas");
  c.width = c.height = (n + 4) * s;
  const g = c.getContext("2d");
  g.fillStyle = "#FEF8EC"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#1B1C20";
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + 2) * s, (r + 2) * s, s, s);
  return `<img src="${c.toDataURL("image/png")}" alt="${esc(label)}" width="${c.width}" height="${c.height}">`;
}
function qrSvg(text, label) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  if (FORCED_DARK) return `<div class="qrcard"><div class="qr">${qrImg(q, n, label)}</div><span class="corner c1"></span><span class="corner c2"></span><span class="corner c3"></span><span class="corner c4"></span></div>`;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
  return `<div class="qrcard"><div class="qr"><svg viewBox="-2 -2 ${n + 4} ${n + 4}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#FEF8EC"/><path d="${d}" fill="#1B1C20"/></svg></div>
    <span class="corner c1"></span><span class="corner c2"></span><span class="corner c3"></span><span class="corner c4"></span><span class="scanline" aria-hidden="true"></span></div>`;
}
const STATUS_ICON = { awaiting: "clock", seen: "loader", paid: "check", review: "alert", expired: "hourglass", cancelled: "ban" };
const shortStatus = (st, iAmReceiver) => statusWord(st, iAmReceiver);
/** A status chip: icon + one word on screen, the full plain-language status for screen readers. */
function chip(st, full, iAmReceiver, cls = "status", role = "") {
  return `<span class="${cls} ${esc(st)}" ${role} title="${esc(full)}">${icon(STATUS_ICON[st] ?? "clock")}<span aria-hidden="true">${esc(shortStatus(st, iAmReceiver))}</span><span class="sr">${esc(full)}</span></span>`;
}
let ringN = 0;
function ring(done, total, cls = "") {
  const r = 42, c = 2 * Math.PI * r, pct = total ? done / total : 0, id = `rg${++ringN}`;
  return `<div class="ring ${cls}" role="img" aria-label="${done} of ${total} paid"><svg viewBox="0 0 100 100" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFB347"/><stop offset="1" stop-color="#4ADE80"/></linearGradient></defs>
    <circle class="track" cx="50" cy="50" r="${r}" fill="none" stroke-width="10"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#${id})" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}" style="transition:stroke-dashoffset .8s"/></svg>
    <b aria-hidden="true">${done}/${total}</b></div>`;
}
/** A segmented ring for the split preview: one arc per share. */
function slicesRing(parts) {
  const r = 42, c = 2 * Math.PI * r, gap = parts > 1 ? 6 : 0, seg = c / parts - gap;
  const arcs = Array.from({ length: parts }, (_, i) => `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${i === 0 ? "#F7931A" : i % 2 ? "#FFB347" : "#E8730C"}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${seg.toFixed(1)} ${(c - seg).toFixed(1)}" stroke-dashoffset="${(-i * (c / parts)).toFixed(1)}"/>`).join("");
  return `<div class="ring" aria-hidden="true"><svg viewBox="0 0 100 100">${arcs}</svg><b>${parts}×</b></div>`;
}
function burst() {
  const bits = Array.from({ length: 12 }, (_, i) => `<i style="--r:${i * 30}deg;--d:${58 + (i % 3) * 10}px;--c:${BRAND[i % BRAND.length]}"></i>`).join("");
  return `<div class="burst" aria-hidden="true"><span class="wave"></span>${bits}<span class="disc">${icon("check", { size: 56 })}</span></div>`;
}
function confetti() {
  if (calm()) return;
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = Array.from({ length: 36 }, () => `<i style="left:${Math.random() * 100}%;--c:${BRAND[Math.floor(Math.random() * BRAND.length)]};--x:${(Math.random() * 120 - 60).toFixed(0)}px;--r:${(Math.random() * 720 - 360).toFixed(0)}deg;--t:${(1.4 + Math.random() * 1.2).toFixed(2)}s;--dl:${(Math.random() * .3).toFixed(2)}s"></i>`).join("");
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3000);
}
let toastTimer;
function toast(text, ic = "check") {
  const t = document.getElementById("toast");
  t.innerHTML = `${ic ? icon(ic, { size: 20 }) : ""}<span>${esc(String(text).replace(/\s*✓\s*$/, ""))}</span>`;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}
async function copy(text, what = "Copied", btn = null) {
  try { await navigator.clipboard.writeText(text); } catch { prompt("Copy this:", text); return; }
  toast(what, "check");
  haptic(10);
  if (btn) {
    // The button itself says it worked: a check and "Copied" for a moment.
    clearTimeout(btn._t);
    btn._html ??= btn.innerHTML;
    btn.classList.add("done");
    btn.innerHTML = `${icon("check")}<span>Copied</span>`;
    btn._t = setTimeout(() => { btn.classList.remove("done"); btn.innerHTML = btn._html; btn._html = null; }, 1600);
  }
}
/** A copy button that turns into a check when it worked. */
const copyBtn = (text, label, cls = "tool") => `<button type="button" class="${cls}" data-act="copy" data-copy="${esc(text)}" data-what="${esc(label)} copied" aria-label="Copy ${esc(label.toLowerCase())}">${icon("copy")}<span>${esc(label)}</span></button>`;
/** The receiver address, readable: groups of four, digits tinted, first and last group bold. */
function addrCard(address, network) {
  const g = addressGroups(address);
  const body = g.map((x, i) => `<span class="g${i === 0 || i === g.length - 1 ? " edge4" : ""}">${[...x].map((ch) => /\d/.test(ch) ? `<i>${esc(ch)}</i>` : esc(ch)).join("")}</span>`).join("");
  return `<div class="addr"><div class="addr-top"><span class="lbl">${icon("wallet", { size: 16 })}To · ${esc(network)}</span>${copyBtn(address, "Address", "mini")}</div>
    <p class="addr-v" aria-hidden="true">${body}</p><p class="sr">Receiver address: ${esc([...address].join(" "))}</p>
    <p class="addr-hint">${icon("shield", { size: 14 })}Check the first and last 4 in your wallet</p></div>`;
}
/** Time left on an open request. */
const expChip = (v) => { const left = !FINAL.has(v.status) && v.expires_at ? timeLeft(v.expires_at) : null; return left ? `<span class="exp">${icon("hourglass", { size: 16 })}${esc(left)} left</span>` : ""; };
/** A friendly, full-screen error with one way out. */
function errorScreen(err, { title } = {}) {
  const msg = friendly(err);
  const off = /offline/i.test(msg);
  const link = /link/i.test(msg);
  mount(`<header class="bar">${logo}<h1>${esc(title ?? (off ? "Offline" : link ? "Link not working" : "Oops"))}</h1></header>
    <div class="state-x"><span class="state-ic ${off ? "warn" : "bad"}">${icon(off ? "wifi-off" : link ? "unlink" : "alert", { size: 40 })}</span>
      <p class="lead">${esc(msg)}</p></div>
    <div class="stack"><a class="btn primary" href="#/">${icon("home")}Home</a>${off ? `<button class="btn secondary" data-act="retry">${icon("refresh")}Try again</button>` : ""}</div>`, { retry: () => render() });
}
const skeleton = () => `<div class="skel" aria-busy="true" aria-label="Loading"><span class="sk sk-bar"></span><span class="sk sk-circle"></span><span class="sk sk-line w60"></span><span class="sk sk-big"></span><span class="sk sk-line w40"></span><span class="sk sk-btn"></span></div>`;

/**
 * In-app confirm as a bottom sheet: icon, one short line, a danger action and a safe one.
 * A real modal: role="dialog" + aria-modal, the rest of the page is inert, focus starts on the
 * safe button and is trapped inside, Esc or a tap on the backdrop keeps things as they are,
 * and focus returns to the button that opened it. Resolves true only for the danger action.
 */
function sheet({ ic = "alert", title, line, yes, no = "Keep it" }) {
  const host = $app.parentElement;
  const opener = document.activeElement;
  const id = `sh${Date.now().toString(36)}`;
  host.insertAdjacentHTML("beforeend", `<div class="sheet-wrap" data-sheet>
    <div class="sheet-back" data-sheet-no></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="${id}t" aria-describedby="${id}d">
      <span class="sheet-grab" aria-hidden="true"></span>
      <span class="state-ic bad sheet-ic">${icon(ic, { size: 28 })}</span>
      <h2 id="${id}t">${esc(title)}</h2>
      <p id="${id}d">${esc(line)}</p>
      <button type="button" class="btn danger big" data-sheet-yes>${icon(ic)}${esc(yes)}</button>
      <button type="button" class="btn secondary" data-sheet-no>${esc(no)}</button>
    </div></div>`);
  const wrap = host.lastElementChild;
  const others = [...host.children].filter((el) => el !== wrap && !el.inert);
  for (const el of others) el.inert = true;
  const buttons = [...wrap.querySelectorAll("button")];
  requestAnimationFrame(() => { wrap.classList.add("open"); buttons[1].focus(); });
  haptic(8);
  return new Promise((resolve) => {
    const close = (answer) => {
      document.removeEventListener("keydown", key, true);
      for (const el of others) el.inert = false;
      wrap.classList.remove("open");
      setTimeout(() => wrap.remove(), calm() ? 0 : 220);
      if (opener && document.contains(opener)) opener.focus();
      resolve(answer);
    };
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(false); }
      else if (e.key === "Tab") {
        const i = buttons.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? buttons.length - 1 : i - 1) : (i + 1) % buttons.length;
        e.preventDefault(); buttons[next].focus();
      }
    };
    document.addEventListener("keydown", key, true);
    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-sheet-yes]")) close(true);
      else if (e.target.closest("[data-sheet-no]")) close(false);
    });
  });
}
async function share(url, title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  copy(url, "Link copied");
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("pair.theme", t); } catch { /* private mode */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#FEF8EC" : "#121316");
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", `${t} only`);
}
const theme = () => !FORCED_DARK && document.documentElement.dataset.theme === "light" ? "light" : "dark";
// Light/dark lives in Settings: headers keep one or two icons at most.
const themeBtn = () => "";
const backBtn = () => `<button class="iconbtn back" type="button" data-act="back" aria-label="Back">${icon("chevron-left")}</button>`;
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const clientKey = () => randomId().replace(/-/g, "");

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), query: new URLSearchParams(qs ?? "") };
}

// ---- render loop ---------------------------------------------------------
async function render() {
  cleanup.forEach((f) => f());
  cleanup = [];
  const { parts, query } = parseRoute();
  try {
    if (parts[0] === "r" && parts[1]) return await screenPay(parts[1], query.get("k") ?? "");
    if (parts[0] === "paid" && parts[1]) return await screenReceipt(parts[1]);
    if (!api.hasUser()) {
      if (parts[0] === "p" && parts[1]) sessionStorage.setItem("pair.pending", parts[1]);
      return screenOnboarding();
    }
    me = await api.me();
    if (parts[0] === "p" && parts[1]) return await screenPair(parts[1]);
    const pending = sessionStorage.getItem("pair.pending");
    if (pending) { sessionStorage.removeItem("pair.pending"); return go(`#/p/${pending}`); }
    if (parts[0] === "new") return screenNew(query);
    if (parts[0] === "sent") return screenSent(query.get("ids")?.split(",") ?? []);
    if (parts[0] === "me") return screenMyCode();
    if (parts[0] === "settings") return screenSettings();
    if (parts[0] === "history") return screenHistory(query);
    return screenHome();
  } catch (err) {
    if (err.status === 401) { api.forget(); return go("#/"); }
    errorScreen(err);
  }
}
function mount(html, handlers = {}) {
  const all = {
    theme: () => { setTheme(theme() === "dark" ? "light" : "dark"); render(); },
    copy: (el) => copy(el.dataset.copy, el.dataset.what || "Copied", el),
    ...handlers,
  };
  $app.innerHTML = html;
  addEdges($app);
  $app.onclick = async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !all[el.dataset.act] || el.tagName === "FORM") return;
    e.preventDefault();
    if (el.dataset.busy) return; // one tap at a time: no double requests, double cancels or double simulations
    el.dataset.busy = "1";
    el.setAttribute("aria-busy", "true");
    try { await all[el.dataset.act](el, e); } catch (err) { toast(friendly(err), "alert"); haptic([20, 40, 20]); } finally { delete el.dataset.busy; el.removeAttribute("aria-busy"); }
  };
  $app.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!all[f.dataset.act]) return;
    const b = f.querySelector("[type=submit]");
    if (f.dataset.busy || f.dataset.done) return; // in flight, or already done and about to leave the screen
    if (b) b.disabled = true;
    f.dataset.busy = "1";
    let done = false;
    try { await all[f.dataset.act](f, e); done = true; } catch (err) { toast(friendly(err), "alert"); haptic([20, 40, 20]); } finally {
      delete f.dataset.busy;
      if (done) f.dataset.done = "1"; // a form that worked stays locked until the next screen replaces it
      else if (b && document.contains(b)) { b.disabled = false; all.input?.(f.querySelector("input"), e); }
    }
  };
  $app.oninput = (e) => all.input?.(e.target, e);
  window.scrollTo(0, 0);
  // A new screen: move focus to its heading so screen readers announce it (not on live refreshes).
  if (location.hash !== lastRoute) {
    lastRoute = location.hash;
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body && $app.contains(document.activeElement) && document.activeElement.matches("input, select, textarea")) return;
      const h = $app.querySelector("h1");
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    });
  }
}
let lastRoute = null;
const footer = (full = false) => `<footer class="foot">
  <span class="l">${icon("shield")}Your wallet signs. send21 never holds funds.</span>
  ${full ? `<span class="l">${icon("flask")}Testnet · ${cfg.static ? "mock, in this browser" : `${esc(cfg.mode)} mode`}</span>
  <a class="l tap" href="mailto:info@send21.io">${icon("mail")}info@send21.io</a>` : ""}</footer>`;

// ---- onboarding: 3 swipeable cards, then a name -------------------------------
const SLIDES = [
  { ic: "qr", h: "Pair in a scan", p: "Scan a friend. Done." },
  { ic: "split", h: "Ask. Split. Paid.", p: "In your own money." },
  { ic: "shield", h: "Your wallet signs", p: "send21 never holds keys or funds." },
];
function screenOnboarding() {
  const seen = localStorage.getItem("pair.onb") || sessionStorage.getItem("pair.pending");
  if (seen) return screenSetup();
  let at = 0;
  mount(`
    <div class="onb">
      <div class="brand">${logo.replace('class="logo"', "")}<span>send21 pair</span></div>
      <button class="btn ghost skip" style="width:auto;padding:0 14px" data-act="skip">Skip</button>
      <div class="slides" id="slides" tabindex="0" role="region" aria-roledescription="carousel" aria-label="Welcome">
        ${SLIDES.map((s, i) => `<section class="slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${SLIDES.length}">
          <div class="big-ic">${icon(s.ic, { size: 84 })}</div><h1>${s.h}</h1><p>${esc(s.p)}</p></section>`).join("")}
      </div>
      <div class="dots">${SLIDES.map((_, i) => `<button type="button" data-act="dot" data-i="${i}" aria-label="Card ${i + 1} of ${SLIDES.length}" aria-current="${i === 0}"><span></span></button>`).join("")}</div>
      <button class="btn primary big" data-act="next" id="next">Next ${icon("chevron-right")}</button>
    </div>`, {
    skip: done,
    dot: (el) => to(Number(el.dataset.i)),
    next: () => (at >= SLIDES.length - 1 ? done() : to(at + 1)),
  });
  const $s = $app.querySelector("#slides");
  function to(i) { $s.scrollTo({ left: i * $s.clientWidth, behavior: calm() ? "auto" : "smooth" }); }
  function sync() {
    at = Math.round($s.scrollLeft / Math.max(1, $s.clientWidth));
    $app.querySelectorAll(".dots button").forEach((b, i) => b.setAttribute("aria-current", String(i === at)));
    $app.querySelector("#next").innerHTML = at >= SLIDES.length - 1 ? `Let's go ${icon("arrow-up-right")}` : `Next ${icon("chevron-right")}`;
  }
  $s.addEventListener("scroll", () => requestAnimationFrame(sync), { passive: true });
  $s.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") to(Math.min(at + 1, SLIDES.length - 1)); if (e.key === "ArrowLeft") to(Math.max(at - 1, 0)); });
  function done() { localStorage.setItem("pair.onb", "1"); screenSetup(); }
}
function screenSetup() {
  const fiat = fiatForLocale(locale);
  const opts = cfg.fiats.map((f) => `<option ${f === fiat ? "selected" : ""}>${f}</option>`).join("");
  mount(`
    <header class="bar">${logo}<h1>send21 pair</h1>${themeBtn()}</header>
    <div class="setup">
      <h1>What's your name?</h1>
      <p class="muted" style="margin:0 0 8px;font-weight:600">No email. No password.</p>
      <form data-act="start">
        <label class="field"><span>${icon("pen")}Name</span><input name="name" autocomplete="nickname" maxlength="40" required placeholder="Your name" enterkeyhint="go"></label>
        <label class="field"><span>${icon("globe")}Currency</span><select name="fiat" aria-label="Currency">${opts}</select></label>
        <button class="btn primary big" type="submit">Start ${icon("arrow-up-right")}</button>
      </form>
      <div class="notice small">${icon("flask")}<div>Test money only. Test wallets are prefilled; change them in Settings.</div></div>
    </div>
    ${footer()}`, {
    async start(f) {
      const name = cleanText(f.name.value, 40);
      if (!name) { f.name.focus(); throw new Error("A name, please"); }
      await api.signup({ name, fiat: f.fiat.value });
      toast(`Hi, ${name}`, "zap");
      window.dispatchEvent(new Event("pair-signed-in"));
      render();
    },
  });
  $app.querySelector("input[name=name]").focus();
}

// ---- home ----------------------------------------------------------------
function activityItem(r) {
  const iGet = r.to_user === me.user.id;
  const other = iGet ? (r.from_user ? r.payer_name : "Anyone") : r.receiver_name;
  const color = iGet ? r.payer_color ?? "#5A5B62" : r.receiver_color;
  const st = r.status;
  const [ic, label] = r.kind === "link" ? ["qr", "QR link"] : r.split_id ? ["split", r.split_title || "Split"] : [iGet ? "arrow-down-left" : "arrow-up-right", r.note || (iGet ? "Request" : r.kind === "send" ? "You pay" : "Asked you")];
  return `<li><a href="${esc(r.pay_path.startsWith("#") ? r.pay_path : `#${r.pay_path}`)}">${r.kind === "link" ? `<span class="avatar sm add" aria-hidden="true">${icon("store", { size: 20 })}</span>` : avatar(other, color, "sm")}
    <span class="what"><b>${esc(other)}</b><span>${icon(ic)}${esc(label)}</span></span>
    <span class="right"><span class="amt ${iGet && st === "paid" ? "in" : ""}">${iGet ? "+" : "−"}${esc(money(r.fiat_amount, r.fiat))}</span>${r.late ? `<span class="status review">${icon("alert")}<span aria-hidden="true">Late pay</span><span class="sr">A payment arrived after it was ${esc(r.late.state)}</span></span>` : chip(st, r.status_text, iGet)}</span></a></li>`;
}
function notices() {
  let out = "";
  if (!me.contacts.length) {
    out += `<div class="notice">${icon("user-plus")}<div><b>Add your first friend</b><br><span class="muted small">Show your code. They scan. Done.</span><a class="btn primary" href="#/me">${icon("qr")}Show my code</a></div></div>`;
  } else if ("Notification" in window && Notification.permission === "default" && !localStorage.getItem("pair.notif.skip")) {
    if (isIOS && !standalone) {
      out += `<div class="notice">${icon("bell")}<div><b>Get pinged</b><br><span class="muted small">On iPhone: Share, “Add to Home Screen”, then open it from there.</span></div></div>`;
    } else {
      out += `<div class="notice">${icon("bell")}<div><b>Get pinged when friends pay</b><div class="row"><button class="btn primary" data-act="notif">Turn on</button><button class="btn secondary" data-act="notifSkip">Later</button></div></div></div>`;
    }
  }
  return out;
}
function splitsOf(list) {
  const groups = new Map();
  for (const r of list) {
    if (!r.split_id || r.to_user !== me.user.id) continue;
    if (!groups.has(r.split_id)) groups.set(r.split_id, { id: r.split_id, title: r.split_title || r.note || "Split", fiat: r.fiat, items: [] });
    groups.get(r.split_id).items.push(r);
  }
  return [...groups.values()];
}
function splitCard(s, big = false) {
  const paid = s.items.filter((r) => r.status === "paid");
  const got = paid.reduce((a, r) => a + r.fiat_amount, 0), all = s.items.reduce((a, r) => a + r.fiat_amount, 0);
  const faces = s.items.map((r) => avatar(r.payer_name, r.payer_color, r.status === "paid" ? "ok" : "")).join("");
  return `<a class="card splitcard" href="#/sent?ids=${esc(s.items.map((r) => r.id).join(","))}" aria-label="${esc(s.title)}: ${paid.length} of ${s.items.length} paid">
    <div class="ringwrap">${ring(paid.length, s.items.length, big ? "lg" : "")}
      <div style="flex:1;min-width:0"><div class="t">${esc(s.title)}</div><div class="muted small" style="font-weight:700">${esc(money(got, s.fiat))} / ${esc(money(all, s.fiat))}</div><div class="faces">${faces}</div></div></div></a>`;
}
function screenHome() {
  const people = me.contacts.map((c) => `<button class="contact" data-act="person" data-id="${esc(c.id)}">${avatar(c.name, c.color)}<span>${esc(first(c.name))}<span class="sr">${esc(String(c.name).slice(first(c.name).length))}, ask for money</span></span></button>`).join("");
  const mine = me.user.fiat;
  const open = (r) => !FINAL.has(r.status);
  const owed = me.activity.filter((r) => r.to_user === me.user.id && open(r) && r.fiat === mine).reduce((a, r) => a + r.fiat_amount, 0);
  const owe = me.activity.filter((r) => r.from_user === me.user.id && r.to_user !== me.user.id && open(r) && r.fiat === mine).reduce((a, r) => a + r.fiat_amount, 0);
  const paidIn = me.activity.filter((r) => r.to_user === me.user.id && r.status === "paid").length;
  const splits = splitsOf(me.activity).slice(0, 2);
  mount(`
    <header class="bar">${logo}<h1><small>Hi,</small>${esc(first(me.user.name))}</h1>
      <a class="iconbtn" href="#/me" aria-label="My code">${icon("qr")}</a>
      <a class="iconbtn" href="#/settings" aria-label="Settings">${icon("settings")}</a></header>
    <section class="hero" aria-label="Summary">
      <div class="lbl">${icon("arrow-down-left", { size: 16 })}Owed to you</div>
      <div class="num">${esc(money(owed, mine))}</div>
      <div class="sub"><span class="tag">${icon("arrow-up-right")}${esc(money(owe, mine))} to pay</span><span class="tag">${icon("check")}${paidIn} paid</span></div>
    </section>
    <nav class="actions" aria-label="Actions">
      <a class="action main" href="#/new?mode=request"><span class="orb">${icon("arrow-down-left")}</span>Request</a>
      <a class="action main" href="#/new?mode=pay"><span class="orb">${icon("arrow-up-right")}</span>Pay</a>
      <a class="action" href="#/new?mode=request&split=1"><span class="orb">${icon("split")}</span>Split</a>
      <a class="action" href="#/new?mode=link"><span class="orb">${icon("qr")}</span>QR</a>
    </nav>
    ${notices()}
    <h2>${icon("users")}People</h2>
    <div class="contacts"><a class="contact" href="#/me" aria-label="Add someone"><span class="avatar add" aria-hidden="true">${icon("plus", { size: 26 })}</span><span>Add</span></a>${people}</div>
    ${splits.length ? `<h2>${icon("split")}Splits</h2>${splits.map((s) => splitCard(s)).join("")}` : ""}
    <h2>${icon("clock")}Activity${me.activity.length > 5 ? `<a class="more" href="#/history">See all ${icon("chevron-right", { size: 16 })}</a>` : ""}</h2>
    <div class="glass" style="padding:0">${me.activity.length ? `<ul class="activity">${me.activity.slice(0, 5).map(activityItem).join("")}</ul>` : emptyActivity()}</div>
    ${footer(true)}`, {
    person: (el) => go(`#/new?mode=request&to=${el.dataset.id}`),
    notif: enableNotifications,
    notifSkip: () => { localStorage.setItem("pair.notif.skip", "1"); render(); },
  });
}

function emptyActivity(text = "Requests and payments show up here.") {
  return `<div class="empty"><span class="state-ic">${icon("inbox", { size: 30 })}</span><b>Nothing yet</b><span class="small">${esc(text)}</span>
    ${me.contacts.length ? `<a class="btn primary" href="#/new?mode=request">${icon("arrow-down-left")}Request money</a>` : ""}</div>`;
}

// ---- history: everything, filtered, grouped by day ----------------------------
const FILTERS = { all: ["All", () => true], open: ["Open", (r) => !FINAL.has(r.status)], paid: ["Paid", (r) => r.status === "paid"], closed: ["Closed", (r) => r.status === "expired" || r.status === "cancelled"] };
function dayLabel(t) {
  const d = new Date(t), today = new Date();
  const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
function screenHistory(query) {
  const f = FILTERS[query.get("f")] ? query.get("f") : "all";
  const list = me.activity.filter(FILTERS[f][1]);
  const groups = [];
  for (const r of list) { const k = dayLabel(r.created_at); if (groups.at(-1)?.k !== k) groups.push({ k, items: [] }); groups.at(-1).items.push(r); }
  mount(`
    <header class="bar">${backBtn()}<h1>History</h1></header>
    <div class="seg four" role="group" aria-label="Filter">${Object.entries(FILTERS).map(([k, [label, fn]]) => `<button type="button" data-act="filter" data-f="${k}" aria-pressed="${k === f}">${esc(label)}<span class="n">${me.activity.filter(fn).length}</span></button>`).join("")}</div>
    ${groups.length ? groups.map((g) => `<h2>${esc(g.k)}</h2><div class="glass" style="padding:0"><ul class="activity">${g.items.map(activityItem).join("")}</ul></div>`).join("")
      : `<div class="glass" style="padding:0;margin-top:16px">${emptyActivity(f === "all" ? "Requests and payments show up here." : "Nothing here right now.")}</div>`}
    ${footer()}`, {
    back: () => go("#/"),
    filter: (el) => go(`#/history?f=${el.dataset.f}`),
  });
}

// ---- notifications ---------------------------------------------------------
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function enableNotifications() {
  if (!("Notification" in window)) return toast("No notifications in this browser", "bell");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Notifications off. Links still work.", "bell"); return render(); }
  if (cfg.vapidPublicKey && "PushManager" in window && navigator.serviceWorker) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(cfg.vapidPublicKey) }));
      await api.savePush(sub.toJSON());
      localStorage.setItem(`pair.push.${slot}`, "1");
    } catch (err) {
      toast(`Push not available here (${err.message}). You'll still be told while the app is open.`, "bell");
    }
  }
  toast("Notifications on", "bell");
  render();
}
async function localNotify(n) {
  // With real push the service worker shows it. Without push, show it ourselves
  // when the app is in the background, else a toast.
  if (document.visibilityState === "visible" || Notification?.permission !== "granted" || localStorage.getItem(`pair.push.${slot}`)) {
    if (document.visibilityState === "visible") toast(`${n.title}${n.body ? ` · ${n.body}` : ""}`, "bell");
    return;
  }
  const reg = await navigator.serviceWorker?.ready;
  reg?.showNotification(n.title, { body: n.body, tag: n.tag, data: { url: n.url }, icon: "icons/icon-192.png", badge: "icons/icon-192.png" });
}

// ---- my code / pairing -----------------------------------------------------
function screenMyCode() {
  const url = api.pairUrl(me);
  const canScan = "BarcodeDetector" in window && navigator.mediaDevices?.getUserMedia;
  mount(`
    <header class="bar">${backBtn()}<h1>My code</h1>${themeBtn()}</header>
    <div class="who"><div class="halo">${avatar(me.user.name, me.user.color, "lg")}</div><div class="title"><b>${esc(me.user.name)}</b></div></div>
    ${qrSvg(url, `QR code to add ${me.user.name}`)}
    <p class="qr-hint">${icon("scan")}Scan with any camera</p>
    <div class="row" style="margin-top:14px">
      <button class="btn primary" data-act="share">${icon("share")}Send link</button>
      ${canScan ? `<button class="btn secondary" data-act="scan">${icon("scan")}Scan</button>` : ""}
    </div>
    ${canScan ? `<video class="scan" hidden playsinline muted></video>` : ""}
    <details><summary>${icon("chevron-right")}Link</summary><p class="linkbox">${esc(url)}</p>
      ${cfg.static ? `<p class="small muted">No server here: the link carries your name and test wallets. They add you; scan theirs to add them back.</p>` : `<button class="btn ghost" data-act="reset">${icon("refresh")}New link (old one stops working)</button>`}
    </details>
    ${footer()}`, {
    back: () => history.length > 1 ? history.back() : go("#/"),
    share: () => share(url, "Add me on send21 pair", `Add me on send21 pair so we can pay each other back.`),
    async reset() { await api.resetPairCode(); toast("New link made", "refresh"); render(); },
    async scan() {
      const video = $app.querySelector("video");
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.hidden = false;
      video.srcObject = stream;
      await video.play();
      const det = new BarcodeDetector({ formats: ["qr_code"] });
      let live = true;
      cleanup.push(() => { live = false; stream.getTracks().forEach((t) => t.stop()); });
      const tick = async () => {
        if (!live) return;
        const codes = await det.detect(video).catch(() => []);
        const hit = codes.map((c) => c.rawValue).find((v) => /#\/p\/|\/p\//.test(v));
        if (hit) { const code = hit.split(/#\/p\/|\/p\//)[1].split(/[?#]/)[0]; return go(`#/p/${code}`); }
        requestAnimationFrame(tick);
      };
      tick();
    },
  });
}
async function screenPair(code) {
  let info;
  try { info = await api.pairInfo(code); } catch (err) {
    return mount(`<header class="bar">${logo}<h1>send21 pair</h1></header><div class="notice">${icon("alert")}<div>${esc(err.message)}</div></div><a class="btn secondary" href="#/">${icon("home")}Home</a>`);
  }
  const f = first(info.name);
  mount(`
    <header class="bar">${logo}<h1>send21 pair</h1>${themeBtn()}</header>
    <div class="who" style="margin-top:40px"><div class="halo">${avatar(info.name, info.color, "xl")}</div>
      <h1 style="font-size:32px;font-weight:900;letter-spacing:-.03em;margin:10px 0 0">Add ${esc(f)}?</h1>
      <p class="muted" style="margin:0;font-weight:600">Ask and pay each other.</p></div>
    <div class="stack" style="margin-top:36px">
      <button class="btn primary big" data-act="add">${icon("user-plus")}Add ${esc(f)}</button>
      <a class="btn secondary" href="#/">Not now</a>
    </div>`, {
    async add() {
      const r = await api.addContact(code);
      toast(r.already ? `${f} is already in your people` : `${f} added`, "user-plus");
      if (r.oneWay) {
        mount(`<header class="bar">${logo}<h1>send21 pair</h1></header>
          <div class="who" style="margin-top:20px">${burst()}<h1 style="font-size:30px;font-weight:900;margin:0">${esc(f)} added</h1></div>
          <div class="notice">${icon("qr")}<div>No server here. Show ${esc(f)} your code too.</div></div>
          <div class="stack"><a class="btn primary" href="#/me">${icon("qr")}Show my code</a><a class="btn secondary" href="#/">Done</a></div>`);
      } else go("#/");
    },
  });
}

// ---- request / pay ---------------------------------------------------------
function screenNew(query) {
  let mode = query.get("mode") ?? "request"; // request | pay | link
  const splitMode = query.get("split") === "1" && mode === "request";
  const selected = new Set(query.get("to") ? [query.get("to")] : []);
  let includeMe = true;
  const myFiat = me.user.fiat;
  const titles = { request: splitMode ? "Split" : "Request", pay: "Pay", link: "QR" };

  const draw = () => {
    const people = me.contacts.map((c) => `<button type="button" class="contact" data-act="pick" data-id="${esc(c.id)}" aria-pressed="${selected.has(c.id)}"><span class="sr">${esc(c.name)}</span><span class="av-wrap">${avatar(c.name, c.color)}<span class="tick">${icon("check", { size: 14 })}</span></span><span aria-hidden="true">${esc(first(c.name))}</span></button>`).join("");
    const seg = mode === "link" || splitMode ? "" : `<div class="seg" role="group" aria-label="Request or pay">
        <button type="button" data-act="mode" data-m="request" aria-pressed="${mode === "request"}">${icon("arrow-down-left", { size: 20 })}Request</button>
        <button type="button" data-act="mode" data-m="pay" aria-pressed="${mode === "pay"}">${icon("arrow-up-right", { size: 20 })}Pay</button></div>`;
    const who = mode === "request" ? (splitMode ? "Who's in?" : "From") : "To";
    mount(`
      <header class="bar">${backBtn()}<h1>${titles[mode]}</h1>${themeBtn()}</header>
      ${seg}
      <form data-act="submit">
        ${mode === "link" ? `<div class="notice">${icon("store")}<div><b>Anyone can pay</b><br><span class="muted small">They scan, tap “Open wallet”. No app needed.</span></div></div>` : `
        <h2>${icon(mode === "pay" ? "arrow-up-right" : "users")}${who}${mode === "request" && !splitMode ? ` <span style="text-transform:none;letter-spacing:0;font-weight:600">· pick 2+ to split</span>` : ""}</h2>
        ${me.contacts.length ? `<div class="contacts">${people}</div>` : `<div class="notice">${icon("user-plus")}<div>Add someone first. <a href="#/me">My code</a></div></div>`}`}
        <div class="amount"><label class="sr" for="amt">Amount in ${myFiat}</label><input id="amt" name="amount" inputmode="decimal" autocomplete="off" enterkeyhint="done" placeholder="0" aria-describedby="amthint crypto" value="${esc(sanitizeAmountInput(query.get("amount") ?? "", myFiat))}"><span class="ccy">${myFiat}</span></div>
        <p class="amthint" id="amthint" aria-live="polite"></p>
        <p class="crypto" id="crypto"></p>
        <label class="notefield">${icon("pen")}<span class="sr">What's it for? (optional)</span><input name="note" maxlength="80" autocomplete="off" enterkeyhint="done" placeholder="What for? Pizza, taxi…" value="${esc(cleanText(query.get("note") ?? "", 80))}"></label>
        <div id="split"></div>
        <button class="btn primary big" type="submit" id="go">${titles[mode]}</button>
      </form>
      ${footer()}`, handlers);
    // One key per screen: a double tap or a retry creates the request once.
    $app.querySelector("form").dataset.key = key;
    update();
  };
  const key = clientKey();

  const parsed = () => parseAmount($app.querySelector("#amt")?.value ?? "", myFiat);
  const amountVal = () => { const p = parsed(); return p.ok ? p.value : 0; };
  const target = () => (mode === "pay" ? me.contacts.find((c) => selected.has(c.id)) : null);
  function update() {
    const $amt = $app.querySelector("#amt");
    $amt.style.width = `${Math.min(9, Math.max(1, $amt.value.length)) + 0.3}ch`;
    const pa = parsed();
    const amt = pa.ok ? pa.value : 0;
    const $h = $app.querySelector("#amthint");
    const bad = !pa.ok && !pa.empty;
    $h.innerHTML = bad ? `${icon("alert", { size: 16 })}<span>${esc(pa.error)}</span>` : "";
    $amt.setAttribute("aria-invalid", String(bad));
    const n = mode === "request" ? selected.size : 1;
    const parts = mode === "request" && n > 1 ? n + (includeMe ? 1 : 0) : 1;
    const share = parts > 1 ? splitShares(amt, n, includeMe, myFiat).friends.at(-1) : amt; // the base share (any remainder sits with you, or the first person)
    const accepts = mode === "pay" ? target()?.accepts ?? [] : Object.keys(me.addresses);
    const asset = pickAsset(accepts, myFiat, cfg.mode);
    const $c = $app.querySelector("#crypto");
    let text;
    if (mode === "pay" && !target()) text = "Pick who to pay";
    else if (!asset) text = mode === "pay" ? `${target().name} has no wallet yet` : "Add a wallet in Settings";
    else if (cfg.mode === "demo") text = `Testnet demo: send21 sets a fixed test amount (about 0.10 USD) in ${ASSETS[asset].label} on ${networkOf(asset, "demo").name}`;
    else if (cfg.mode === "api") text = `${ASSETS[asset].label} on ${networkOf(asset, "api").name} · send21 locks the rate`;
    else if (share > 0) { const c = cryptoLine(mockBaseUnits(share, myFiat, asset), asset, "mock"); text = `≈ ${c.amount} ${c.symbol} · ${c.network} · mock rate`; }
    else text = `${ASSETS[asset].label} on ${networkOf(asset, cfg.mode).name}`;
    $c.innerHTML = `${icon(asset ? "zap" : "alert")}<span>${esc(text)}</span>`;
    const $s = $app.querySelector("#split");
    $s.innerHTML = parts > 1 || (mode === "request" && n > 1) ? `<div class="card"><div class="ringwrap">${slicesRing(parts)}<div style="flex:1">
        <div style="font-size:24px;font-weight:900;letter-spacing:-.02em">${esc(money(share, myFiat))} <span class="muted" style="font-size:15px">each</span></div>
        <label class="check"><input type="checkbox" id="inc" ${includeMe ? "checked" : ""}> I'm in too</label></div></div>
        <p class="sr">Split ${parts} ways: ${esc(money(share, myFiat))} each from ${n} ${n === 1 ? "person" : "people"}</p></div>` : "";
    const names = [...selected].map((id) => first(me.contacts.find((c) => c.id === id)?.name)).filter(Boolean);
    const $go = $app.querySelector("#go");
    const amtText = amt > 0 ? money(parts > 1 ? share : amt, myFiat) : "";
    const label = mode === "link" ? `Show QR${amtText ? ` · ${amtText}` : ""}`
      : mode === "pay" ? (names[0] ? `Pay ${names[0]}${amtText ? ` ${amtText}` : ""}` : "Pay")
      : names.length > 1 ? `Request ${amtText} each` : names[0] ? `Request ${amtText}`.trim() : titles[mode];
    $go.innerHTML = `${icon(mode === "link" ? "qr" : mode === "pay" ? "arrow-up-right" : names.length > 1 ? "split" : "arrow-down-left")}${esc(label)}`;
    $go.disabled = !(amt > 0) || (mode !== "link" && selected.size === 0) || !asset;
  }
  const handlers = {
    back: () => go("#/"),
    mode: (el) => { mode = el.dataset.m; if (mode === "pay" && selected.size > 1) { const f = [...selected][0]; selected.clear(); selected.add(f); } keep(); draw(); },
    pick: (el) => {
      const id = el.dataset.id;
      if (mode === "pay") { selected.clear(); selected.add(id); }
      else if (selected.has(id)) selected.delete(id); else selected.add(id);
      for (const b of $app.querySelectorAll("[data-act=pick]")) b.setAttribute("aria-pressed", String(selected.has(b.dataset.id)));
      update();
    },
    input: (el) => {
      if (el?.id === "inc") includeMe = el.checked;
      if (el?.id === "amt") { const clean = sanitizeAmountInput(el.value, myFiat); if (clean !== el.value) el.value = clean; }
      update();
    },
    async submit(f) {
      const kind = mode === "pay" ? "send" : mode;
      const pa = parsed();
      if (!pa.ok) { $app.querySelector("#amt").focus(); throw new Error(pa.error); }
      const reqs = await api.createRequests({ kind, contactIds: [...selected], amount: $app.querySelector("#amt").value, fiat: myFiat, note: cleanText(f.note.value, 80), includeMe, clientKey: f.dataset.key });
      haptic(15);
      if (kind === "request") go(`#/sent?ids=${reqs.map((r) => r.id).join(",")}`);
      else go(reqs[0].pay_path.startsWith("#") ? reqs[0].pay_path : `#${reqs[0].pay_path}`);
    },
  };
  // Keep what was typed when switching Request/Pay.
  const keep = () => {
    const a = $app.querySelector("#amt")?.value; const n = $app.querySelector("input[name=note]")?.value;
    if (a) query.set("amount", a); if (n) query.set("note", n);
  };
  draw();
  $app.querySelector("#amt").focus();
}

async function screenSent(ids) {
  drawSent(ids);
  const off = api.subscribeMe(async (m) => { if (m.type === "refresh") { me = await api.me(); drawSent(ids); } });
  cleanup.push(off);
}
function drawSent(ids) {
  const items = me.activity.filter((r) => ids.includes(r.id));
  const split = items.length > 1 ? splitsOf(items)[0] : null;
  const rows = items.map((r) => `<div class="card" style="display:flex;align-items:center;gap:12px">${avatar(r.payer_name, r.payer_color, "sm")}
      <div style="flex:1;min-width:0"><b>${esc(r.payer_name)}</b><br>${chip(r.status, r.status_text, true)}</div>
      <b style="font-variant-numeric:tabular-nums">${esc(money(r.fiat_amount, r.fiat))}</b>
      <button class="iconbtn" data-act="share" data-url="${esc(api.payUrl(r))}" data-name="${esc(r.payer_name)}" aria-label="${cfg.static ? "Send" : "Share"} link to ${esc(r.payer_name)}">${icon("share")}</button></div>`).join("");
  const allPaid = items.length && items.every((r) => r.status === "paid");
  const one = items.length === 1 && items[0].status !== "paid" ? items[0] : null;
  mount(`
    <header class="bar">${logo}<h1>${split ? "Split sent" : "Request sent"}</h1></header>
    ${split ? `<div class="who">${ring(items.filter((r) => r.status === "paid").length, items.length, "lg")}<div class="title"><b>${esc(split.title)}</b> · ${esc(money(items.reduce((a, r) => a + r.fiat_amount, 0), items[0].fiat))}</div></div>`
      : allPaid ? burst() : `<div class="who"><div class="halo"><span class="avatar xl" style="background-color:#F7931A" aria-hidden="true">${icon("send", { size: 44 })}</span></div></div>`}
    <p class="center muted" style="font-weight:700">${cfg.static ? "Send them the link." : "They get pinged. Track it here."}</p>
    ${rows}
    <div class="stack" style="margin-top:18px">
      ${one ? `<button class="btn primary" data-act="share" data-url="${esc(api.payUrl(one))}">${icon("share")}Send link to ${esc(first(one.payer_name))}</button>` : ""}
      <a class="btn ${one ? "secondary" : "primary"}" href="#/">${icon("check")}Done</a></div>`, {
    share: (el) => share(el.dataset.url, "send21 pair", `${me.user.name} asks you for money on send21 pair`),
  });
}

// ---- the pay screen (works without the app and without a name) -------------
const CLOSED_COPY = {
  expired: { ic: "hourglass", t: "Expired", mine: "Nobody paid in time.", other: (f) => `Ask ${f} for a new link. Don't pay this one.` },
  cancelled: { ic: "ban", t: "Cancelled", mine: "You cancelled this request.", other: (f) => `${f} cancelled it. Don't pay this one.` },
};
/** What happened, in one line, and one next step: the closed and mismatch states. */
function statePanel(view, mine, f) {
  const st = view.status;
  if (st === "review") {
    return `<div class="state review" role="note"><span class="state-ic warn">${icon("alert", { size: 26 })}</span><div><b>Amount mismatch</b>
      <p>${mine ? "The amount paid isn't what you asked for. Check your wallet before you call it settled." : `It didn't match what ${esc(f)} asked for. ${esc(f)} will check.`}</p>
      ${view.review_note ? `<p class="small muted">${esc(view.review_note)}</p>` : ""}</div></div>`;
  }
  const c = CLOSED_COPY[st];
  if (!c) return "";
  return `<div class="state ${st}" role="note"><span class="state-ic bad">${icon(c.ic, { size: 26 })}</span><div><b>${c.t}</b><p>${esc(mine ? c.mine : c.other(f))}</p></div></div>`;
}
/** A payment that arrived after the request was closed. The request keeps its state; this says so. */
function lateCard(late, mine, otherName) {
  if (!late) return "";
  const what = { expired: "expired", cancelled: "cancelled", paid: "already paid" }[late.state] ?? late.state;
  return `<div class="late" role="alert"><div class="late-top"><span class="state-ic warn">${icon("alert", { size: 24 })}</span><b>Payment after close</b></div>
    <p>A payment arrived after this request was <b>${esc(what)}</b>.${late.amount ? ` Amount: ${esc(late.amount)}.` : ""}</p>
    <div class="kv"><span>State</span>${chip(late.state, `Request ${what}`, mine, "status")}</div>
    <div class="kv"><span>Tx</span><code>${esc(String(late.tx_id).slice(0, 10))}…${esc(String(late.tx_id).slice(-6))}</code>${copyBtn(late.tx_id, "Tx id", "mini")}</div>
    <p class="small muted">${mine ? `It's in your wallet. Sort it out with ${esc(otherName ?? "the payer")}: any refund is up to you, from your own wallet.` : `Tell ${esc(otherName)}. Any refund is up to them, from their own wallet.`}</p></div>`;
}
async function screenPay(id, k) {
  mount(`<header class="bar">${logo}<h1>Pay</h1></header>${skeleton()}`);
  let view = await api.payInfo(id, k);
  if (api.hasUser() && !me) me = await api.me().catch(() => null);
  let qrOpen = !touch;
  const draw = (celebrate = false) => {
    const mine = me && view.receiver.id === me.user.id;
    const f = first(view.receiver.name);
    const c = view.crypto;
    const paid = view.status === "paid";
    const final = FINAL.has(view.status);
    const head = mine
      ? (view.kind === "link" ? "Scan to pay" : view.kind === "send" ? `<b>${esc(view.payer?.name)}</b> sends you` : `You asked <b>${esc(view.payer?.name ?? "")}</b>`)
      : view.kind === "send" ? `Pay <b>${esc(view.receiver.name)}</b>` : `<b>${esc(view.receiver.name)}</b> asks`;
    const pageUrl = cfg.static ? api.payUrl({ pay_path: `#/r/${id}` }) : new URL(`r/${view.id}?k=${encodeURIComponent(k)}`, location.href.split("#")[0].split("?")[0]).href;
    const statusLine = mine
      ? statusText({ status: view.status, to_user: view.receiver.id, from_user: view.payer?.id ?? null, payer_name: view.payer?.name }, me.user.id)
      : view.status_text;
    const cryptoText = c ? `≈ ${c.amount} ${c.symbol} · ${c.network}` : `${view.asset_label} · ${view.network}`;
    const wallet = safeHref(view.payment_uri);
    const page = safeHref(view.pay_url);
    const walletBtn = wallet
      ? `<a class="btn primary big" href="${esc(wallet)}" data-act="wallet">${icon("wallet")}Open wallet</a>`
      : page ? `<a class="btn primary big" href="${esc(page)}" rel="noopener">${icon("external")}Open pay page</a>` : "";
    const mock = view.source === "mock" || view.source === "static";
    const exact = c && view.source !== "demo" ? `<div class="kv exact"><span>${icon("zap", { size: 16 })}Wallet amount</span><b>${esc(c.exact)} ${esc(c.symbol)}</b>${copyBtn(c.exact, "Amount", "mini")}</div>` : "";
    const tests = (inner) => `<div class="mockbox"><div class="lbl">${icon("flask")}Test tools · no real payment</div>${inner}</div>`;
    // The payer sees the wallet step only while the request is waiting for them.
    const payerPart = view.status === "seen" ? `<div class="state seen" role="note"><span class="state-ic">${icon("loader", { size: 26, cls: "spin" })}</span><div><b>On its way</b><p>Seen on the network. Waiting for confirmation.</p></div></div>`
      : view.status === "review" ? "" : final ? (mock && view.status !== "paid" ? tests(`<button class="btn ghost" data-act="simLate">${icon("alert", { size: 18 })}Simulate a payment after close</button>`) : "") : `
      <div style="margin-top:20px">${walletBtn}</div>
      ${wallet ? `${addrCard(view.receiver_address, view.network)}${exact}
        <div class="tools two">
        <button class="tool" data-act="qr" aria-expanded="${qrOpen}" aria-controls="wqr">${icon("qr")}<span>Wallet QR</span></button>
        ${copyBtn(wallet, "Pay link")}</div>
        <div id="wqr" ${qrOpen ? "" : "hidden"}>${qrSvg(wallet, "Wallet QR code")}<p class="qr-hint">${icon("wallet")}Scan with your wallet</p></div>` : ""}
      ${mock ? tests(`<button class="btn secondary" data-act="sim">${icon("play", { size: 18 })}Simulate payment</button>
        <details class="more"><summary>${icon("chevron-right")}More outcomes</summary><div class="row">
          <button class="btn ghost" data-act="simBad">${icon("alert", { size: 18 })}Wrong amount</button>
          <button class="btn ghost" data-act="simExpire">${icon("hourglass", { size: 18 })}Expire now</button></div></details>`) : ""}
      ${view.source === "demo" ? `<div class="notice small">${icon("flask")}<div><b>send21 testnet demo.</b> The wallet amount is send21's fixed test amount and it goes to send21's demo wallet, not to ${esc(f)}. Test coins: <a href="https://faucet.solana.com" rel="noopener">faucet.solana.com</a>, <a href="https://faucet.circle.com" rel="noopener">faucet.circle.com</a>.</div></div>` : ""}`;
    const again = view.payer && view.kind !== "link" ? `#/new?mode=request&to=${encodeURIComponent(view.payer.id)}&amount=${encodeURIComponent(view.fiat_amount)}&note=${encodeURIComponent(view.note ?? "")}` : `#/new?mode=${view.kind === "link" ? "link" : "request"}&amount=${encodeURIComponent(view.fiat_amount)}&note=${encodeURIComponent(view.note ?? "")}`;
    const receiverPart = final ? `
      ${view.status !== "paid" && view.kind !== "send" ? `<a class="btn primary" href="${esc(again)}" style="margin-top:16px">${icon("refresh")}Ask again</a>` : ""}
      ${mock && view.status !== "paid" ? tests(`<button class="btn ghost" data-act="simLate">${icon("alert", { size: 18 })}Simulate a payment after close</button>`) : ""}` : `
      ${view.kind === "link" || view.kind === "request" ? `${qrSvg(pageUrl, "QR code of the pay page")}<p class="qr-hint">${icon("scan")}Scan with any camera</p>` : ""}
      ${cfg.mode === "api" && view.asset === "eth-base" ? `<div class="notice small">${icon("zap")}<div>ETH on Base: send21 spots it by balance. Confirm it in send21 with one click when it lands.</div></div>` : ""}
      <div class="stack" style="margin-top:14px">
        ${view.kind !== "send" ? `<button class="btn primary" data-act="share">${icon("share")}Share link</button>` : ""}
        <div class="row">
        ${view.payer && view.kind === "request" && !cfg.static ? `<button class="btn secondary" data-act="remind">${icon("bell")}Remind</button>` : ""}
        ${view.kind !== "send" ? `<button class="btn secondary" data-act="cancel">${icon("ban")}Cancel</button>` : ""}
        </div>
      </div>
      ${mock ? tests(`<button class="btn secondary" data-act="sim">${icon("play", { size: 18 })}Simulate the payer</button>
        <details class="more"><summary>${icon("chevron-right")}More outcomes</summary><div class="row">
          <button class="btn ghost" data-act="simBad">${icon("alert", { size: 18 })}Wrong amount</button>
          <button class="btn ghost" data-act="simExpire">${icon("hourglass", { size: 18 })}Expire now</button></div></details>`) : ""}`;
    const receipt = cfg.static && paid && !mine && view.receipt && view.payer
      ? `<div class="notice">${icon("receipt")}<div>No server here. Tell ${esc(f)}:<button class="btn primary" data-act="receipt">${icon("send")}Send ${esc(f)} the receipt</button></div></div>` : "";
    const face = mine ? (view.payer ? avatar(view.payer.name, view.payer.color ?? "#FEF8EC", "lg") : `<span class="avatar lg add" aria-hidden="true">${icon("store", { size: 34 })}</span>`) : avatar(view.receiver.name, view.receiver.color, "lg");
    const otherName = mine ? view.payer?.name : view.receiver.name;
    mount(`
      <header class="bar">${me ? backBtn() : logo}<h1>${mine ? "Your request" : "Pay"}</h1>${themeBtn()}</header>
      ${paid ? burst() : `<div class="who"><div class="halo">${face}</div></div>`}
      <div class="who"><div class="title">${paid ? (mine ? "You got paid" : "You paid") : head}</div></div>
      <p class="bigamt${final && !paid ? " void" : ""}">${esc(money(view.fiat_amount, view.fiat))}</p>
      <p class="crypto">${icon("zap")}<span>${esc(cryptoText)}${view.testnet ? " · testnet" : ""}</span></p>
      ${view.note ? `<div class="note"><span>${icon("pen")}${esc(view.note)}</span></div>` : ""}
      <p class="center chips" style="margin:10px 0">${chip(view.status, statusLine, !!mine, "pill", 'role="status"')}${expChip(view)}</p>
      ${paid && view.tx_id ? `<div class="kv tx"><span>Tx</span><code>${esc(String(view.tx_id).slice(0, 10))}…${esc(String(view.tx_id).slice(-6))}</code>${copyBtn(view.tx_id, "Tx id", "mini")}</div>` : ""}
      ${statePanel(view, mine, f)}
      ${lateCard(view.late, !!mine, otherName)}
      ${receipt}
      ${mine ? receiverPart : payerPart}
      ${!api.hasUser() ? `<div class="card" style="margin-top:24px;display:flex;gap:12px;align-items:center">${logo.replace('class="logo"', 'class="logo" style="width:44px;height:44px"')}<div style="flex:1"><b>Get send21 pair</b><br><span class="muted small">Ask and pay friends.</span></div><a class="iconbtn" href="#/" data-act="own" aria-label="Get send21 pair">${icon("chevron-right")}</a></div>` : ""}
      ${footer(true)}`, {
      back: () => go("#/"),
      wallet: (el) => { haptic(10); location.href = el.getAttribute("href"); },
      qr: (el) => { qrOpen = !qrOpen; el.setAttribute("aria-expanded", String(qrOpen)); $app.querySelector("#wqr").hidden = !qrOpen; },
      sim: async () => { await api.simulate(id, k, "ok"); toast("Payment sent (simulated)", "play"); },
      simBad: async () => { await api.simulate(id, k, "wrong_amount"); toast("Wrong amount sent (simulated)", "alert"); },
      simExpire: async () => { await api.simulate(id, k, "expire"); toast("Expired (simulated)", "hourglass"); },
      simLate: async () => { await api.simulate(id, k, "late"); toast("Payment after close (simulated)", "alert"); },
      share: () => share(pageUrl, "send21 pair", `${view.receiver.name} asks for ${money(view.fiat_amount, view.fiat)}${view.note ? ` for ${view.note}` : ""}`),
      remind: async () => { await api.remind(view.id); toast("Reminder sent", "bell"); },
      cancel: async () => { if (await sheet({ ic: "ban", title: "Cancel this request?", line: "The link stops working. You can ask again any time.", yes: "Cancel request" })) { await api.cancel(view.id); haptic(15); go("#/"); } },
      receipt: () => share(api.receiptUrl(view.receipt), "Paid ✓", `I paid you ${money(view.fiat_amount, view.fiat)} on send21 pair`),
      own: () => { sessionStorage.removeItem("pair.pending"); go("#/"); },
    });
    if (celebrate) { confetti(); haptic([30, 40, 60]); }
  };
  draw();
  const sig = (v) => `${v.status}|${v.late?.tx_id ?? ""}`;
  const off = api.subscribePay(id, k, (v) => {
    const changed = sig(v) !== sig(view);
    const nowPaid = v.status === "paid" && view.status !== "paid";
    const nowLate = v.late && !view.late;
    view = v;
    if (changed) { draw(nowPaid); if (nowPaid) toast("Paid"); else if (nowLate) { toast("Payment after close", "alert"); haptic([20, 40, 20]); } }
  });
  cleanup.push(off);
  // Count down to expiry while the screen is open.
  const tick = setInterval(() => { if (!FINAL.has(view.status) && view.expires_at && view.expires_at <= Date.now()) api.payInfo(id, k).then((v) => { if (sig(v) !== sig(view)) { view = v; draw(); } }).catch(() => {}); }, 15_000);
  cleanup.push(() => clearInterval(tick));
}

async function screenReceipt(enc) {
  if (!api.applyReceipt || !api.hasUser()) return go("#/");
  const r = await api.applyReceipt(enc);
  if (r.after_close) {
    mount(`<header class="bar">${logo}<h1>Payment after close</h1></header>
      <div class="who"><div class="title"><b>${esc(r.payer_name ?? "They")}</b> paid</div></div>
      <p class="bigamt">${esc(money(r.fiat_amount, r.fiat))}</p>
      ${lateCard(r.late, true, r.payer_name)}
      <a class="btn primary" href="${esc(r.pay_path.startsWith("#") ? r.pay_path : `#${r.pay_path}`)}" style="margin-top:20px">${icon("receipt")}Open the request</a>`);
    haptic([20, 40, 20]);
    return;
  }
  mount(`<header class="bar">${logo}<h1>Paid</h1></header>
    ${burst()}
    <div class="who"><div class="title"><b>${esc(r.payer_name ?? "They")}</b> paid you</div></div>
    <p class="bigamt">${esc(money(r.fiat_amount, r.fiat))}</p>
    <p class="center" style="margin:10px 0">${chip("paid", "Paid ✓", true, "pill")}</p>
    <a class="btn primary" href="#/" style="margin-top:20px">${icon("check")}Done</a>`);
  confetti();
  haptic([30, 40, 60]);
}

// ---- settings --------------------------------------------------------------
function screenSettings() {
  const fiats = cfg.fiats.map((f) => `<option ${f === me.user.fiat ? "selected" : ""}>${f}</option>`).join("");
  const addr = cfg.assets.map((a) => `<label class="field"><span>${icon("wallet")}${esc(a.label)} · ${esc(a.network)}</span><input class="mono" name="addr:${esc(a.id)}" data-asset="${esc(a.id)}" value="${esc(me.addresses[a.id] ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Not set" aria-describedby="err-${esc(a.id)}"><small class="ferr" id="err-${esc(a.id)}" aria-live="polite"></small></label>`).join("");
  const n = "Notification" in window ? Notification.permission : "unsupported";
  mount(`
    <header class="bar">${backBtn()}<h1>Settings</h1></header>
    <div class="card setrow">${icon(theme() === "dark" ? "moon" : "sun")}<span class="lbl" id="dm">Dark mode<small>${theme() === "dark" ? "On" : "Off"}</small></span>
      <button class="toggle" type="button" role="switch" aria-checked="${theme() === "dark"}" aria-labelledby="dm" data-act="theme"><span></span></button></div>
    <form data-act="save">
      <label class="field"><span>${icon("pen")}Name</span><input name="name" value="${esc(me.user.name)}" maxlength="40" required></label>
      <label class="field"><span>${icon("globe")}Currency</span><select name="fiat">${fiats}</select></label>
      <h2>${icon("wallet")}Get paid to</h2>
      <p class="small muted" style="margin-top:-4px">Your own addresses (${cfg.mode === "api" ? "LIVE networks" : "test networks"}). Payers can't change them. Empty = not accepted.</p>
      ${cfg.demoAddresses ? `<button type="button" class="btn ghost" data-act="demoAddr">${icon("refresh")}Use the send21 testnet demo wallets</button>` : ""}
      ${addr}
      <button class="btn primary" type="submit">${icon("check")}Save</button>
    </form>
    <h2>${icon("bell")}Notifications</h2>
    <div class="card setrow">${icon("bell")}<span class="lbl">Status<small>${esc(n)}${isIOS && !standalone ? " · add to Home Screen first" : ""}</small></span>
      ${n === "default" ? `<button class="btn secondary" style="width:auto;padding:0 16px;min-height:48px" data-act="notif">Turn on</button>` : ""}${n === "granted" ? `<button class="btn secondary" style="width:auto;padding:0 16px;min-height:48px" data-act="testPush">Test</button>` : ""}</div>
    <h2>${icon("log-out")}This device</h2>
    <button class="btn secondary" data-act="forget">${icon("trash")}Forget me here</button>
    ${footer(true)}`, {
    back: () => go("#/"),
    demoAddr: () => { for (const [id, v] of Object.entries(cfg.demoAddresses)) { const i = $app.querySelector(`[name="addr:${id}"]`); if (i) { i.value = v; checkAddr(i); } } toast("Test wallets filled in", "refresh"); },
    input: (el) => { if (el?.dataset.asset) checkAddr(el); },
    async save(f) {
      const addresses = {};
      let bad = null;
      for (const a of cfg.assets) { const i = f[`addr:${a.id}`]; addresses[a.id] = i.value.trim(); if (!checkAddr(i)) bad ??= i; }
      if (bad) { bad.focus(); throw new Error("Fix the address in red first"); }
      const name = cleanText(f.name.value, 40);
      if (!name) { f.name.focus(); throw new Error("A name, please"); }
      await api.updateMe({ name, fiat: f.fiat.value, addresses });
      toast("Saved");
      go("#/");
    },
    notif: enableNotifications,
    testPush: async () => { await api.testPush(); toast("Sent. It should arrive in a moment.", "bell"); },
    forget: async () => { if (await sheet({ ic: "trash", title: "Forget me here?", line: "Your name and contacts leave this device.", yes: "Forget me", no: "Keep me" })) { api.forget(); location.hash = "#/"; location.reload(); } },
  });
}

/** Address fields check themselves as you type: wrong network or a typo shows right under the field. */
function checkAddr(input) {
  const a = cfg.assets.find((x) => x.id === input.dataset.asset);
  const v = input.value.trim();
  const ok = !v || validAddress(a.id, v, cfg.mode);
  input.setAttribute("aria-invalid", String(!ok));
  const e = document.getElementById(`err-${a.id}`);
  if (e) e.innerHTML = ok ? "" : `${icon("alert", { size: 14 })}Not a ${esc(a.label)} address on ${esc(a.network)}`;
  return ok;
}

// ---- start -------------------------------------------------------------------
async function start() {
  try { cfg = await api.config(); } catch (err) {
    cfg = { mode: "mock", static: false, fiats: [], assets: [] };
    return errorScreen(err, { title: "Can't connect" });
  }
  if (FORCED_DARK) document.documentElement.dataset.theme = "dark";
  const badge = document.querySelector(".testnet");
  badge.innerHTML = cfg.mode === "api"
    ? `<span>${icon("alert", { size: 14 })}LIVE NETWORKS · real money</span>`
    : `<span>${icon("flask", { size: 14 })}TESTNET</span><span class="sr"> · test money only, nothing here has value</span>`;
  if (cfg.mode === "api") badge.classList.add("live");
  // Offline: a small chip next to the badge; the static demo keeps working, server actions say so.
  badge.insertAdjacentHTML("beforeend", `<span class="offline" hidden>${icon("wifi-off", { size: 14 })}Offline</span>`);
  const net = () => { badge.querySelector(".offline").hidden = navigator.onLine; };
  addEventListener("online", net); addEventListener("offline", net); net();
  setTheme(theme());
  if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
  window.addEventListener("hashchange", render);
  let liveOff = null;
  const connect = () => {
    liveOff?.();
    liveOff = api.subscribeMe(async (m) => {
      if (m.type === "notify") localNotify(m);
      if (m.type === "refresh" && (parseRoute().parts.length === 0)) { me = await api.me(); screenHome(); }
    });
  };
  window.addEventListener("pair-signed-in", connect);
  await render();
  connect();
}
start();
