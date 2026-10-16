// dewby: a white-label example app on send21. The money logic (lib/, server/) is shared with
// apps/send21-pair; this file is only the UI. Brand values come from brand.js (window.BRAND).
import { ASSETS, DEMO_ADDRESSES, FINAL, avatarColor, cryptoLine, encodeCard, fiatForLocale, formatFiat, initials, mockBaseUnits, networkOf, pickAsset, randomId, splitAmount, statusText } from "./lib/core.js";
import { serverApi } from "./lib/server-api.js";
import { staticApi } from "./lib/static-api.js";
import qrcode from "./vendor/qrcode.js";
import { icon } from "./icons.js";

// ---- setup ---------------------------------------------------------------
const B = window.BRAND;
const K = (k) => `${B.storagePrefix}.${k}`;
const params = new URLSearchParams(location.search);
if (params.get("as")) sessionStorage.setItem(K("slot"), params.get("as").replace(/[^a-z0-9_-]/gi, "").slice(0, 20));
const slot = sessionStorage.getItem(K("slot")) || "default";
const BOOT = window.APP_BOOT ?? { backend: "static", mode: "mock" };
const api = BOOT.backend === "server" ? serverApi(slot, { storagePrefix: B.storagePrefix }) : staticApi(slot, { storagePrefix: B.storagePrefix, memo: B.name });
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
const mark = (cls = "mark") => `<img class="${cls}" src="icons/mark.svg" alt="" aria-hidden="true">`;
const wordmark = () => `<span class="brand">${mark()}<svg class="wm" viewBox="-7 0 238 86" role="img" aria-label="${esc(B.name)}"><g fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="20" cy="43" r="16"/><path d="M36 8v52"/><path d="M48 43h32a16 16 0 1 0-4.7 11.3"/><path d="M92 27l9 32 13-26 13 26 9-32"/>
  <path d="M150 8v52"/><circle cx="166" cy="43" r="16"/><path d="M190 27l14 31"/><path d="M218 27l-15 39q-4 11-15 11"/></g></svg></span>`;

// Forced dark (Samsung Internet's default "Force Dark Only", Android WebView): the browser repaints the
// page, darkening light or saturated fills and inverting dark text, and ignores color-scheme opt-outs.
// Detect it the documented way (a light-only probe whose Canvas color is not white) and switch to a
// palette that survives: dark fills, color only as text, icons and SVG strokes, QR codes as images.
function detectForcedDark() {
  const d = document.createElement("div");
  d.style.cssText = "position:absolute;width:1px;height:1px;left:-9px;top:-9px;background-color:Canvas;color-scheme:light only";
  document.body.appendChild(d);
  const c = getComputedStyle(d).backgroundColor;
  d.remove();
  return !/^rgba?\(255, 255, 255/.test(c);
}
const FORCED_DARK = params.has("fd") || detectForcedDark();
if (FORCED_DARK) document.documentElement.classList.add("fd");
const EDGE_SEL = ".btn.primary, .bubble, .tile, .seg button[aria-pressed=true], .chipnav a[aria-current=page]";
function addEdges(root) {
  if (!FORCED_DARK) return;
  for (const el of root.querySelectorAll(EDGE_SEL)) {
    if (el.querySelector(":scope > .edge")) continue;
    el.insertAdjacentHTML("beforeend", '<svg class="edge" aria-hidden="true" focusable="false"><rect/></svg>');
  }
}
const L = B.light;
const CONFETTI = [L.mint, L.lime, L.sea, L.pop, "#7CF0C8", "#FFD3E0"];

// ---- small UI pieces ---------------------------------------------------------
/** The shared server hands out avatar colors; map them onto this brand's avatar palette. */
function tint(color) {
  if (!color) return L.mint;
  let h = 0;
  for (const c of String(color)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return B.avatars[h % B.avatars.length];
}
function avatar(name, color, cls = "") {
  return `<span class="avatar ${cls}" style="background-color:${esc(tint(color))}" aria-hidden="true">${esc(initials(name ?? "?"))}</span>`;
}
function qrImg(q, n, label) {
  const s = 8, c = document.createElement("canvas");
  c.width = c.height = (n + 4) * s;
  const g = c.getContext("2d");
  g.fillStyle = "#FFFFFF"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = L.ink;
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + 2) * s, (r + 2) * s, s, s);
  return `<img src="${c.toDataURL("image/png")}" alt="${esc(label)}" width="${c.width}" height="${c.height}">`;
}
function qrBox(text, label) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  if (FORCED_DARK) return `<div class="qrcard"><div class="qr">${qrImg(q, n, label)}</div></div>`;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
  return `<div class="qrcard"><div class="qr"><svg viewBox="-2 -2 ${n + 4} ${n + 4}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#FFFFFF"/><path d="${d}" fill="${L.ink}"/></svg></div>${mark("qrmark")}</div>`;
}
const STATUS_ICON = { awaiting: "clock", seen: "loader", paid: "check", review: "alert", expired: "hourglass", cancelled: "ban" };
function shortStatus(st, iAmReceiver) {
  return { awaiting: iAmReceiver ? "Waiting" : "To pay", seen: "Paying", paid: "Paid", review: "Check", expired: "Expired", cancelled: "Cancelled" }[st] ?? st;
}
/** A status chip: icon + one word on screen, the full plain-language status for screen readers. */
function chip(st, full, iAmReceiver, cls = "status", role = "") {
  return `<span class="${cls} ${esc(st)}" ${role} title="${esc(full)}">${icon(STATUS_ICON[st] ?? "clock")}<span aria-hidden="true">${esc(shortStatus(st, iAmReceiver))}</span><span class="sr">${esc(full)}</span></span>`;
}
let ringN = 0;
function ring(done, total, cls = "") {
  const r = 42, c = 2 * Math.PI * r, pct = total ? done / total : 0, id = `rg${++ringN}`;
  return `<div class="ring ${cls}" role="img" aria-label="${done} of ${total} paid"><svg viewBox="0 0 100 100" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${L.lime}"/><stop offset="1" stop-color="${L.mint}"/></linearGradient></defs>
    <circle class="track" cx="50" cy="50" r="${r}" fill="none" stroke-width="12"/>
    <circle cx="50" cy="50" r="${r}" fill="none" stroke="url(#${id})" stroke-width="12" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}" style="transition:stroke-dashoffset .8s"/></svg>
    <b aria-hidden="true">${done}/${total}</b></div>`;
}
/** Pie-like slices for the split preview: one bubble per share. */
function slicesRing(parts) {
  const r = 42, c = 2 * Math.PI * r, gap = parts > 1 ? 7 : 0, seg = c / parts - gap;
  const cols = [L.mint, L.lime, L.pop, L.sea];
  const arcs = Array.from({ length: parts }, (_, i) => `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${cols[i % cols.length]}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${seg.toFixed(1)} ${(c - seg).toFixed(1)}" stroke-dashoffset="${(-i * (c / parts)).toFixed(1)}"/>`).join("");
  return `<div class="ring" aria-hidden="true"><svg viewBox="0 0 100 100">${arcs}</svg><b>${parts}×</b></div>`;
}
/** The payment-success moment: a dew drop lands, splashes into droplets, then shows the check. */
function splash() {
  const bits = Array.from({ length: 14 }, (_, i) => `<i style="--r:${i * (360 / 14)}deg;--d:${70 + (i % 3) * 14}px;--c:${CONFETTI[i % CONFETTI.length]};--s:${8 + (i % 3) * 3}px"></i>`).join("");
  return `<div class="splash" aria-hidden="true"><span class="ripple r1"></span><span class="ripple r2"></span>${bits}
    <span class="drop">${icon("check", { size: 60 })}</span></div>`;
}
function confetti() {
  if (calm()) return;
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = Array.from({ length: 40 }, (_, i) => `<i class="${i % 3 ? "dot" : "dew"}" style="left:${Math.random() * 100}%;--c:${CONFETTI[Math.floor(Math.random() * CONFETTI.length)]};--x:${(Math.random() * 120 - 60).toFixed(0)}px;--r:${(Math.random() * 540 - 270).toFixed(0)}deg;--t:${(1.4 + Math.random() * 1.2).toFixed(2)}s;--dl:${(Math.random() * .3).toFixed(2)}s"></i>`).join("");
  (document.querySelector(".phone") ?? document.body).appendChild(box);
  setTimeout(() => box.remove(), 3000);
}
/** Shrinks big numbers (amounts) until they fit their box, so 10 000,00 kr never clips on a 360 px phone. */
function fit(root = $app) {
  for (const el of root.querySelectorAll("[data-fit]")) {
    el.style.fontSize = "";
    let size = parseFloat(getComputedStyle(el).fontSize);
    const min = Number(el.dataset.fit) || 28;
    while (el.scrollWidth > el.clientWidth + 1 && size > min) { size -= 2; el.style.fontSize = `${size}px`; }
  }
}
function fitInput($amt) {
  const box = $amt.parentElement, ccy = box.querySelector(".ccy");
  const room = box.clientWidth - (ccy?.offsetWidth ?? 0) - 16;
  const chars = Math.max(1, $amt.value.length);
  const size = Math.max(36, Math.min(84, room / (chars * 0.62 + 0.3)));
  $amt.style.fontSize = `${size}px`;
  $amt.style.width = `${chars + 0.3}ch`;
}

// ---- demo friend: one person can try the whole loop on one phone (mock modes only) ----
const DEMO_NAME = "Demo friend";
const isDemo = (c) => c && c.name === DEMO_NAME && localStorage.getItem(K("demo.id")) === c.id;
const demoFriend = () => me?.contacts.find(isDemo);
async function addDemoFriend() {
  if (cfg.mode !== "mock") throw new Error("The demo friend is for mock mode");
  if (demoFriend()) return demoFriend();
  let code;
  if (cfg.static) {
    const id = randomId();
    code = encodeCard({ v: 1, i: id, n: DEMO_NAME, c: avatarColor(id), a: DEMO_ADDRESSES });
    localStorage.setItem(K("demo.id"), id);
  } else {
    // A second mock user on this server, paired with you. Its token is thrown away: you only ever see it from your side.
    const post = await fetch("api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: DEMO_NAME, fiat: me.user.fiat }) }).then((r) => r.json());
    const info = await fetch("api/me", { headers: { Authorization: `Bearer ${post.token}` } }).then((r) => r.json());
    code = info.user.pair_path.split("/p/")[1];
    localStorage.setItem(K("demo.id"), post.user.id);
  }
  await api.addContact(code);
  me = await api.me();
  return demoFriend();
}
const demoBtn = (cls = "btn secondary") => cfg.mode === "mock" ? `<button class="${cls}" type="button" data-act="demoFriend">${icon("sparkles")}Try it with a demo friend</button>` : "";
async function startDemo() {
  const f = await addDemoFriend();
  toast(`${DEMO_NAME} added`, "user-plus");
  go(`#/new?mode=request&to=${f.id}&amount=120&note=Pizza&demo=1`);
}
/** Pay or get paid by the demo friend: open the pay screen and let the friend's side happen by itself. */
function demoPlay(r) {
  sessionStorage.setItem(K("autosim"), r.id);
  go(r.pay_path.startsWith("#") ? r.pay_path : `#${r.pay_path}`);
}

let toastTimer;
function toast(text, ic = "check") {
  const t = document.getElementById("toast");
  t.innerHTML = `${ic ? icon(ic, { size: 20 }) : ""}<span>${esc(String(text).replace(/\s*✓\s*$/, ""))}</span>`;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}
async function copy(text, what = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(what, "copy"); } catch { prompt("Copy this:", text); }
}
async function share(url, title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  copy(url, "Link copied");
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(K("theme"), t); } catch { /* private mode */ }
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", B[t].bg);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", `${t} only`);
}
const theme = () => FORCED_DARK || document.documentElement.dataset.theme === "dark" ? "dark" : "light";
const backBtn = () => `<button class="iconbtn back" type="button" data-act="back" aria-label="Back">${icon("chevron-left")}</button>`;
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const clientKey = () => randomId().replace(/-/g, "");
const bar = (title, right = "") => `<header class="bar">${backBtn()}<h1>${title}</h1>${right}</header>`;

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
      if (parts[0] === "p" && parts[1]) sessionStorage.setItem(K("pending"), parts[1]);
      return screenOnboarding();
    }
    me = await api.me();
    if (parts[0] === "p" && parts[1]) return await screenPair(parts[1]);
    const pending = sessionStorage.getItem(K("pending"));
    if (pending) { sessionStorage.removeItem(K("pending")); return go(`#/p/${pending}`); }
    if (parts[0] === "new") return screenNew(query);
    if (parts[0] === "sent") return screenSent(query.get("ids")?.split(",") ?? []);
    if (parts[0] === "me") return screenMyCode();
    if (parts[0] === "settings") return screenSettings();
    return screenHome();
  } catch (err) {
    if (err.status === 401) { api.forget(); return go("#/"); }
    mount(`<header class="bar">${wordmark()}</header>
      <div class="notice">${icon("alert")}<div>${esc(err.message)}</div></div>
      <a class="btn secondary" href="#/">${icon("home")}Home</a>`);
  }
}
function mount(html, handlers = {}) {
  const all = { theme: () => { setTheme(theme() === "dark" ? "light" : "dark"); render(); }, demoFriend: () => startDemo(), ...handlers };
  $app.innerHTML = html;
  addEdges($app);
  $app.onclick = async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !all[el.dataset.act] || el.tagName === "FORM") return;
    e.preventDefault();
    try { await all[el.dataset.act](el, e); } catch (err) { toast(err.message, "alert"); }
  };
  $app.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!all[f.dataset.act]) return;
    const b = f.querySelector("[type=submit]");
    if (b) b.disabled = true;
    try { await all[f.dataset.act](f, e); } catch (err) { toast(err.message, "alert"); } finally { if (b && document.contains(b)) b.disabled = false; }
  };
  $app.oninput = (e) => all.input?.(e.target, e);
  fit();
  window.scrollTo(0, 0);
  $app.scrollTop = 0;
}
const footer = () => `<footer class="foot">
  <span class="l">${icon("shield")}You sign in your own wallet. No one here holds your keys or funds.</span>
  <span class="l">${icon("flask")}Test money only · ${cfg.static ? "mock, in this browser" : `${esc(cfg.mode)} mode`}</span></footer>`;

// ---- onboarding: 3 cards, then a name -------------------------------------------
const SLIDES = [
  { ic: "arrow-down-left", c: "mint", h: "Pay friends back", p: "Ask, split a bill, or show a QR. Test money only." },
  { ic: "qr", c: "lime", h: "Scan a friend", p: "One scan and you're connected." },
  { ic: "shield", c: "pop", h: "Your wallet signs", p: "Your keys, your money. Always." },
];
function screenOnboarding() {
  const seen = localStorage.getItem(K("onb")) || sessionStorage.getItem(K("pending"));
  if (seen) return screenSetup();
  let at = 0;
  mount(`
    <div class="onb">
      <div class="onbtop">${wordmark()}<button class="btn ghost skip" data-act="skip">Skip</button></div>
      <div class="slides" id="slides" tabindex="0" role="region" aria-roledescription="carousel" aria-label="Welcome">
        ${SLIDES.map((s, i) => `<section class="slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${SLIDES.length}">
          <div class="blob ${s.c}"><span class="b1"></span><span class="b2"></span>${icon(s.ic, { size: 88 })}</div><h1>${s.h}</h1><p>${esc(s.p)}</p></section>`).join("")}
      </div>
      <div class="dots">${SLIDES.map((_, i) => `<button type="button" data-act="dot" data-i="${i}" aria-label="Card ${i + 1}" aria-current="${i === 0}"></button>`).join("")}</div>
      <button class="btn primary big" data-act="next" id="next">Next ${icon("chevron-right")}</button>
      ${cfg.mode === "mock" ? `<button class="btn ghost" data-act="tryDemo">${icon("sparkles")}Try it alone with a demo friend</button>` : ""}
    </div>`, {
    skip: done,
    tryDemo: () => { sessionStorage.setItem(K("wantDemo"), "1"); done(); },
    dot: (el) => to(Number(el.dataset.i)),
    next: () => (at >= SLIDES.length - 1 ? done() : to(at + 1)),
  });
  const $s = $app.querySelector("#slides");
  function to(i) { $s.scrollTo({ left: i * $s.clientWidth, behavior: calm() ? "auto" : "smooth" }); }
  function sync() {
    at = Math.round($s.scrollLeft / Math.max(1, $s.clientWidth));
    $app.querySelectorAll(".dots button").forEach((b, i) => b.setAttribute("aria-current", String(i === at)));
    $app.querySelector("#next").innerHTML = at >= SLIDES.length - 1 ? `Let's go ${icon("sparkles")}` : `Next ${icon("chevron-right")}`;
  }
  $s.addEventListener("scroll", () => requestAnimationFrame(sync), { passive: true });
  $s.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") to(Math.min(at + 1, SLIDES.length - 1)); if (e.key === "ArrowLeft") to(Math.max(at - 1, 0)); });
  function done() { localStorage.setItem(K("onb"), "1"); screenSetup(); }
}
function screenSetup() {
  const fiat = fiatForLocale(locale);
  const opts = cfg.fiats.map((f) => `<option ${f === fiat ? "selected" : ""}>${f}</option>`).join("");
  mount(`
    <header class="bar">${wordmark()}</header>
    <div class="setup">
      <div class="hi">${mark("mark xl wave")}</div>
      <h1>${sessionStorage.getItem(K("wantDemo")) ? "First, your name" : "Hey! What's your name?"}</h1>
      <p class="muted lead">No email. No password.</p>
      <form data-act="start">
        <label class="field"><span>${icon("pen")}Name</span><input name="name" autocomplete="nickname" maxlength="40" required placeholder="Alex"></label>
        <label class="field"><span>${icon("globe")}Currency</span><select name="fiat" aria-label="Currency">${opts}</select></label>
        <button class="btn primary big" type="submit">Start ${icon("sparkles")}</button>
      </form>
      <div class="notice small">${icon("flask")}<div>Test money only. Test wallets are prefilled; change them in Settings.</div></div>
    </div>
    ${footer()}`, {
    async start(f) {
      await api.signup({ name: f.name.value, fiat: f.fiat.value });
      toast(`Hi, ${f.name.value.trim()}`, "sparkles");
      window.dispatchEvent(new Event("app-signed-in"));
      if (sessionStorage.getItem(K("wantDemo"))) {
        sessionStorage.removeItem(K("wantDemo"));
        me = await api.me();
        return startDemo();
      }
      render();
    },
  });
  $app.querySelector("input[name=name]").focus();
}

// ---- home ----------------------------------------------------------------
function activityItem(r) {
  const iGet = r.to_user === me.user.id;
  const other = iGet ? (r.from_user ? r.payer_name : "Anyone") : r.receiver_name;
  const color = iGet ? r.payer_color ?? L.sea : r.receiver_color;
  const st = r.status;
  const [ic, label] = r.kind === "link" ? ["qr", "QR"] : r.split_id ? ["split", r.split_title || "Split"] : [iGet ? "arrow-down-left" : "arrow-up-right", r.note || (iGet ? "Request" : r.kind === "send" ? "You pay" : "Asked you")];
  return `<li><a href="${esc(r.pay_path.startsWith("#") ? r.pay_path : `#${r.pay_path}`)}">${r.kind === "link" ? `<span class="avatar sm add" aria-hidden="true">${icon("store", { size: 20 })}</span>` : avatar(other, color, "sm")}
    <span class="what"><b>${esc(other)}</b><span>${icon(ic)}${esc(label)}</span></span>
    <span class="right"><span class="amt ${iGet ? "in" : "out"}">${iGet ? "+" : "−"}${esc(money(r.fiat_amount, r.fiat))}</span>${chip(st, r.status_text, iGet)}</span></a></li>`;
}
function notices() {
  let out = "";
  if (!me.contacts.length) {
    out += `<div class="notice pop">${icon("user-plus")}<div><b>Add your first friend</b><br><span class="muted small">Show your code. They scan. Done.</span><a class="btn primary" href="#/me">${icon("qr")}My code</a>${demoBtn()}</div></div>`;
  } else if (demoFriend() && !me.activity.length) {
    out += `<div class="notice pop">${icon("sparkles")}<div><b>Try the loop</b><br><span class="muted small">Ask ${DEMO_NAME} for 120 and watch it get paid.</span><a class="btn primary" href="#/new?mode=request&to=${esc(demoFriend().id)}&amount=120&note=Pizza&demo=1">${icon("arrow-down-left")}Ask ${DEMO_NAME}</a></div></div>`;
  } else if ("Notification" in window && Notification.permission === "default" && !localStorage.getItem(K("notif.skip"))) {
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
function splitCard(s) {
  const paid = s.items.filter((r) => r.status === "paid");
  const got = paid.reduce((a, r) => a + r.fiat_amount, 0), all = s.items.reduce((a, r) => a + r.fiat_amount, 0);
  const faces = s.items.map((r) => avatar(r.payer_name, r.payer_color, r.status === "paid" ? "ok" : "")).join("");
  return `<a class="card splitcard" href="#/sent?ids=${esc(s.items.map((r) => r.id).join(","))}" aria-label="${esc(s.title)}: ${paid.length} of ${s.items.length} paid">
    <div class="ringwrap">${ring(paid.length, s.items.length)}
      <div style="flex:1;min-width:0"><div class="t">${esc(s.title)}</div><div class="muted small b">${esc(money(got, s.fiat))} / ${esc(money(all, s.fiat))}</div><div class="faces">${faces}</div></div></div></a>`;
}
function screenHome() {
  const people = me.contacts.map((c) => `<button class="contact" data-act="person" data-id="${esc(c.id)}" aria-label="Request from ${esc(c.name)}">${avatar(c.name, c.color)}<span>${esc(first(c.name))}</span></button>`).join("");
  const mine = me.user.fiat;
  const open = (r) => !FINAL.has(r.status);
  const owed = me.activity.filter((r) => r.to_user === me.user.id && open(r) && r.fiat === mine).reduce((a, r) => a + r.fiat_amount, 0);
  const owe = me.activity.filter((r) => r.from_user === me.user.id && r.to_user !== me.user.id && open(r) && r.fiat === mine).reduce((a, r) => a + r.fiat_amount, 0);
  const paidIn = me.activity.filter((r) => r.to_user === me.user.id && r.status === "paid").length;
  const splits = splitsOf(me.activity).slice(0, 2);
  mount(`
    <header class="bar home">${mark()}<h1><small>Hey</small>${esc(first(me.user.name))}</h1>
      <a class="iconbtn" href="#/me" aria-label="My code">${icon("qr")}</a>
      <a class="iconbtn me" href="#/settings" aria-label="Settings">${avatar(me.user.name, me.user.color, "xs")}</a></header>
    <section class="bubble" aria-label="Summary">
      <span class="dew d1"></span><span class="dew d2"></span><span class="dew d3"></span>
      <div class="lbl">${icon("arrow-down-left", { size: 16 })}Owed to you</div>
      <div class="num" data-fit="30">${esc(money(owed, mine))}</div>
      <div class="sub"><span class="tag">${icon("arrow-up-right")}${esc(money(owe, mine))} to pay</span><span class="tag">${icon("check")}${paidIn} paid</span></div>
    </section>
    <nav class="tiles" aria-label="Actions">
      <a class="tile mint" href="#/new?mode=request">${icon("arrow-down-left")}<span>Request</span></a>
      <a class="tile pop" href="#/new?mode=pay">${icon("arrow-up-right")}<span>Pay</span></a>
      <a class="tile lime" href="#/new?mode=request&split=1">${icon("split")}<span>Split</span></a>
      <a class="tile sea" href="#/new?mode=link">${icon("qr")}<span>QR</span></a>
    </nav>
    ${notices()}
    <h2>${icon("users")}Friends</h2>
    <div class="contacts"><a class="contact" href="#/me" aria-label="Add a friend"><span class="avatar add" aria-hidden="true">${icon("plus", { size: 26 })}</span><span>Add</span></a>${people}</div>
    ${splits.length ? `<h2>${icon("split")}Splits</h2>${splits.map((s) => splitCard(s)).join("")}` : ""}
    <h2>${icon("clock")}Activity</h2>
    ${me.activity.length ? `<ul class="activity">${me.activity.map(activityItem).join("")}</ul>` : `<div class="empty">${mark("mark lg bob")}<b>All fresh. Nothing yet.</b><span class="small">Requests and payments show up here.</span></div>`}
    ${footer()}`, {
    person: (el) => go(`#/new?mode=request&to=${el.dataset.id}`),
    notif: enableNotifications,
    notifSkip: () => { localStorage.setItem(K("notif.skip"), "1"); render(); },
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
      localStorage.setItem(K(`push.${slot}`), "1");
    } catch (err) {
      toast(`Push not available here (${err.message}). You'll still be told while the app is open.`, "bell");
    }
  }
  toast("Notifications on", "bell");
  render();
}
async function localNotify(n) {
  if (document.visibilityState === "visible" || Notification?.permission !== "granted" || localStorage.getItem(K(`push.${slot}`))) {
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
    ${bar("My code")}
    <div class="who">${avatar(me.user.name, me.user.color, "lg ring-on")}<div class="title"><b>${esc(me.user.name)}</b></div></div>
    ${qrBox(url, `QR code to add ${me.user.name}`)}
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
    share: () => share(url, `Add me on ${B.name}`, `Add me on ${B.name} so we can pay each other back.`),
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
    return mount(`<header class="bar">${wordmark()}</header><div class="notice">${icon("alert")}<div>${esc(err.message)}</div></div><a class="btn secondary" href="#/">${icon("home")}Home</a>`);
  }
  const f = first(info.name);
  mount(`
    <header class="bar">${wordmark()}</header>
    <div class="who" style="margin-top:36px">${avatar(info.name, info.color, "xl ring-on")}
      <h1 class="big-h">Add ${esc(f)}?</h1>
      <p class="muted lead">Ask and pay each other.</p></div>
    <div class="stack" style="margin-top:32px">
      <button class="btn primary big" data-act="add">${icon("user-plus")}Add ${esc(f)}</button>
      <a class="btn secondary" href="#/">Not now</a>
    </div>`, {
    async add() {
      const r = await api.addContact(code);
      toast(r.already ? `${f} is already a friend` : `${f} added`, "user-plus");
      if (r.oneWay) {
        mount(`<header class="bar">${wordmark()}</header>
          <div class="who" style="margin-top:20px">${splash()}<h1 class="big-h">${esc(f)} added</h1></div>
          <div class="notice">${icon("qr")}<div>No server here. Show ${esc(f)} your code too.</div></div>
          <div class="stack"><a class="btn primary" href="#/me">${icon("qr")}My code</a><a class="btn secondary" href="#/">Done</a></div>`);
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
    const people = me.contacts.map((c) => `<button type="button" class="contact" data-act="pick" data-id="${esc(c.id)}" aria-pressed="${selected.has(c.id)}" aria-label="${esc(c.name)}"><span class="av-wrap">${avatar(c.name, c.color)}<span class="tick">${icon("check", { size: 14 })}</span></span><span>${esc(first(c.name))}</span></button>`).join("");
    const seg = mode === "link" || splitMode ? "" : `<div class="seg" role="group" aria-label="Request or pay">
        <button type="button" data-act="mode" data-m="request" aria-pressed="${mode === "request"}">${icon("arrow-down-left", { size: 20 })}Request</button>
        <button type="button" data-act="mode" data-m="pay" aria-pressed="${mode === "pay"}">${icon("arrow-up-right", { size: 20 })}Pay</button></div>`;
    const who = mode === "request" ? (splitMode ? "Who's in?" : "From") : "To";
    mount(`
      ${bar(titles[mode])}
      ${seg}
      <form data-act="submit" class="mode-${mode}${splitMode ? " mode-split" : ""}">
        ${mode === "link" ? `<div class="notice">${icon("store")}<div><b>Anyone can pay</b><br><span class="muted small">They scan, tap “Open wallet”. No app needed.</span></div></div>` : `
        <h2>${icon(mode === "pay" ? "arrow-up-right" : "users")}${who}${mode === "request" && !splitMode ? ` <span class="hint">· pick 2+ to split</span>` : ""}</h2>
        ${me.contacts.length ? `<div class="contacts">${people}</div>` : `<div class="notice">${icon("user-plus")}<div>Add a friend first. <a href="#/me">My code</a></div></div>`}`}
        <div class="amount"><label class="sr" for="amt">Amount in ${myFiat}</label><input id="amt" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(query.get("amount") ?? "")}"><span class="ccy">${myFiat}</span></div>
        <p class="crypto" id="crypto"></p>
        <label class="notefield">${icon("pen")}<span class="sr">What's it for? (optional)</span><input name="note" maxlength="80" placeholder="What for? Pizza, taxi…" value="${esc(query.get("note") ?? "")}"></label>
        <div id="split"></div>
        <button class="btn primary big" type="submit" id="go">${titles[mode]}</button>
      </form>
      ${footer()}`, handlers);
    // One key per screen: a double tap or a retry creates the request once.
    $app.querySelector("form").dataset.key = key;
    update();
  };
  const key = clientKey();

  const amountVal = () => Number(String($app.querySelector("#amt")?.value ?? "").replace(",", ".")) || 0;
  const target = () => (mode === "pay" ? me.contacts.find((c) => selected.has(c.id)) : null);
  let lastAmt = "";
  function update() {
    const $amt = $app.querySelector("#amt");
    fitInput($amt);
    if ($amt.value !== lastAmt && !calm()) { $amt.classList.remove("bump"); void $amt.offsetWidth; $amt.classList.add("bump"); }
    lastAmt = $amt.value;
    const amt = amountVal();
    const n = mode === "request" ? selected.size : 1;
    const parts = mode === "request" && n > 1 ? n + (includeMe ? 1 : 0) : 1;
    const each = parts > 1 ? splitAmount(amt, parts)[0] : amt;
    const accepts = mode === "pay" ? target()?.accepts ?? [] : Object.keys(me.addresses);
    const asset = pickAsset(accepts, myFiat, cfg.mode);
    const $c = $app.querySelector("#crypto");
    let text;
    if (mode === "pay" && !target()) text = "Pick who to pay";
    else if (!asset) text = mode === "pay" ? `${target().name} has no wallet yet` : "Add a wallet in Settings";
    else if (cfg.mode === "demo") text = `Testnet demo: a fixed test amount (about 0.10 USD) in ${ASSETS[asset].label} on ${networkOf(asset, "demo").name}`;
    else if (cfg.mode === "api") text = `${ASSETS[asset].label} on ${networkOf(asset, "api").name} · rate locked when created`;
    else if (each > 0) { const c = cryptoLine(mockBaseUnits(each, myFiat, asset), asset, "mock"); text = `≈ ${c.amount} ${c.symbol} · ${c.network} · mock rate`; }
    else text = `${ASSETS[asset].label} on ${networkOf(asset, cfg.mode).name}`;
    $c.innerHTML = `${icon(asset ? "droplet" : "alert")}<span>${esc(text)}</span>`;
    const $s = $app.querySelector("#split");
    $s.innerHTML = parts > 1 || (mode === "request" && n > 1) ? `<div class="card splitprev"><div class="ringwrap">${slicesRing(parts)}<div style="flex:1">
        <div class="each">${esc(money(each, myFiat))} <span class="muted">each</span></div>
        <label class="check"><input type="checkbox" id="inc" ${includeMe ? "checked" : ""}> I'm in too</label></div></div>
        <p class="sr">Split ${parts} ways: ${esc(money(each, myFiat))} each from ${n} ${n === 1 ? "person" : "people"}</p></div>` : "";
    const names = [...selected].map((id) => first(me.contacts.find((c) => c.id === id)?.name)).filter(Boolean);
    const $go = $app.querySelector("#go");
    const amtText = amt > 0 ? money(parts > 1 ? each : amt, myFiat) : "";
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
    input: (el) => { if (el.id === "inc") includeMe = el.checked; update(); },
    async submit(f) {
      const kind = mode === "pay" ? "send" : mode;
      const reqs = await api.createRequests({ kind, contactIds: [...selected], amount: amountVal(), fiat: myFiat, note: f.note.value.trim(), includeMe, clientKey: f.dataset.key });
      if (kind === "request") go(`#/sent?ids=${reqs.map((r) => r.id).join(",")}`);
      else if (kind === "send" && isDemo(target())) demoPlay(reqs[0]);
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
  const rows = items.map((r) => `<div class="card person">${avatar(r.payer_name, r.payer_color, "sm")}
      <div style="flex:1;min-width:0"><b>${esc(r.payer_name)}</b><br>${chip(r.status, r.status_text, true)}</div>
      <b class="amt">${esc(money(r.fiat_amount, r.fiat))}</b>
      <button class="iconbtn" data-act="share" data-url="${esc(api.payUrl(r))}" data-name="${esc(r.payer_name)}" aria-label="${cfg.static ? "Send" : "Share"} link to ${esc(r.payer_name)}">${icon("share")}</button></div>`).join("");
  const allPaid = items.length && items.every((r) => r.status === "paid");
  const demoReq = items.find((r) => r.status === "awaiting" && isDemo({ id: r.from_user, name: r.payer_name }));
  mount(`
    <header class="bar">${mark()}<h1>${split ? "Split sent" : "Request sent"}</h1></header>
    ${split ? `<div class="who">${ring(items.filter((r) => r.status === "paid").length, items.length, "lg")}<div class="title"><b>${esc(split.title)}</b> · ${esc(money(items.reduce((a, r) => a + r.fiat_amount, 0), items[0].fiat))}</div></div>`
      : allPaid ? splash() : `<div class="who"><span class="avatar xl sentic" aria-hidden="true">${icon("send", { size: 44 })}</span></div>`}
    <p class="center muted b">${cfg.static ? "Send them the link." : "They get pinged. Track it here."}</p>
    ${rows}
    ${demoReq ? `<div class="notice pop">${icon("sparkles")}<div><b>${DEMO_NAME} got your request</b><br><span class="muted small">Watch them pay it (simulated, test money).</span><button class="btn primary" data-act="demoPay">${icon("play")}Let ${DEMO_NAME} pay</button></div></div>` : ""}
    <a class="btn ${demoReq ? "secondary" : "primary"}" href="#/" style="margin-top:18px">${icon("check")}Done</a>`, {
    demoPay: () => demoPlay(demoReq),
    share: (el) => share(el.dataset.url, B.name, `${me.user.name} asks you for money on ${B.name}`),
  });
}

// ---- the pay screen (works without the app and without a name) -------------
async function screenPay(id, k) {
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
    const walletBtn = view.payment_uri
      ? `<a class="btn primary big" href="${esc(view.payment_uri)}" data-act="wallet">${icon("wallet")}Open wallet</a>`
      : view.pay_url ? `<a class="btn primary big" href="${esc(view.pay_url)}" rel="noopener">${icon("external")}Open pay page</a>` : "";
    const mock = view.source === "mock" || view.source === "static";
    const payerPart = final ? "" : `
      <div style="margin-top:20px">${walletBtn}</div>
      ${view.payment_uri ? `<div class="tools">
        <button class="tool" data-act="qr" aria-expanded="${qrOpen}" aria-controls="wqr">${icon("qr")}QR</button>
        <button class="tool" data-act="copyAddr">${icon("copy")}Address</button>
        <button class="tool" data-act="copyAmt">${icon("copy")}Amount</button></div>
        <div id="wqr" ${qrOpen ? "" : "hidden"}>${qrBox(view.payment_uri, "Wallet QR code")}<p class="qr-hint">${icon("wallet")}Scan with your wallet</p></div>` : ""}
      ${mock ? `<div class="mockbox"><div class="lbl">${icon("flask")}Mock · no real payment</div><button class="btn secondary" data-act="sim">${icon("play", { size: 18 })}Simulate payment</button><button class="btn ghost" data-act="simBad">${icon("alert", { size: 18 })}Simulate a wrong amount</button></div>` : ""}
      ${view.source === "demo" ? `<div class="notice small">${icon("flask")}<div><b>Testnet demo.</b> The wallet amount is the demo API's fixed test amount and it goes to the demo wallet, not to ${esc(f)}. Test coins: <a href="https://faucet.solana.com" rel="noopener">faucet.solana.com</a>, <a href="https://faucet.circle.com" rel="noopener">faucet.circle.com</a>.</div></div>` : ""}`;
    const receiverPart = final ? "" : `
      ${view.kind === "link" || view.kind === "request" ? `${qrBox(pageUrl, "QR code of the pay page")}<p class="qr-hint">${icon("scan")}Scan with any camera</p>` : ""}
      <div class="stack" style="margin-top:14px">
        ${view.kind !== "send" ? `<button class="btn primary" data-act="share">${icon("share")}Share link</button>` : ""}
        <div class="row">
        ${view.payer && view.kind === "request" && !cfg.static ? `<button class="btn secondary" data-act="remind">${icon("bell")}Remind</button>` : ""}
        ${view.kind !== "send" ? `<button class="btn secondary" data-act="cancel">${icon("ban")}Cancel</button>` : ""}
        </div>
        ${mock ? `<button class="btn ghost" data-act="sim">${icon("play", { size: 18 })}Simulate the payer</button>` : ""}
      </div>`;
    const receipt = cfg.static && paid && !mine && view.receipt && view.payer
      ? `<div class="notice">${icon("receipt")}<div>No server here. Tell ${esc(f)}:<button class="btn primary" data-act="receipt">${icon("send")}Send ${esc(f)} the receipt</button></div></div>` : "";
    const face = mine ? (view.payer ? avatar(view.payer.name, view.payer.color ?? L.sea, "lg ring-on") : `<span class="avatar lg add" aria-hidden="true">${icon("store", { size: 34 })}</span>`) : avatar(view.receiver.name, view.receiver.color, "lg ring-on");
    mount(`
      <header class="bar">${me ? backBtn() : mark()}<h1>${mine ? "Your request" : "Pay"}</h1></header>
      <div class="paycard ${paid ? "is-paid" : ""}">
        ${paid ? splash() : `<div class="who">${face}</div>`}
        <div class="who"><div class="title">${paid ? `<span class="yay">${mine ? "You got paid!" : "Paid!"}</span>` : head}</div></div>
        <p class="bigamt" data-fit="32">${esc(money(view.fiat_amount, view.fiat))}</p>
        <p class="crypto">${icon("droplet")}<span>${esc(cryptoText)}${view.testnet ? " · testnet" : ""}</span></p>
        ${view.note ? `<div class="note"><span>${icon("pen")}${esc(view.note)}</span></div>` : ""}
        <p class="center" style="margin:10px 0 0">${chip(view.status, statusLine, !!mine, "pill", 'role="status"')}</p>
      </div>
      ${paid && view.tx_id ? `<p class="center small muted">Tx ${esc(view.tx_id.slice(0, 18))}…</p>` : ""}
      ${view.review_note ? `<div class="notice small">${icon("alert")}<div>${esc(view.review_note)}</div></div>` : ""}
      ${receipt}
      ${mine ? receiverPart : payerPart}
      ${!api.hasUser() ? `<div class="card getapp">${mark("mark lg")}<div style="flex:1"><b>Get ${esc(B.name)}</b><br><span class="muted small">Ask and pay friends.</span></div><a class="iconbtn" href="#/" data-act="own" aria-label="Get ${esc(B.name)}">${icon("chevron-right")}</a></div>` : ""}
      ${footer()}`, {
      back: () => go("#/"),
      wallet: (el) => { location.href = el.getAttribute("href"); },
      qr: (el) => { qrOpen = !qrOpen; el.setAttribute("aria-expanded", String(qrOpen)); $app.querySelector("#wqr").hidden = !qrOpen; },
      copyAddr: () => copy(view.receiver_address, "Address copied"),
      copyAmt: () => copy(c?.exact ?? "", "Amount copied"),
      sim: async () => { await api.simulate(id, k, "ok"); toast("Payment sent (simulated)", "play"); },
      simBad: async () => { await api.simulate(id, k, "wrong_amount"); toast("Wrong amount sent (simulated)", "alert"); },
      share: () => share(pageUrl, B.name, `${view.receiver.name} asks for ${money(view.fiat_amount, view.fiat)}${view.note ? ` for ${view.note}` : ""}`),
      remind: async () => { await api.remind(view.id); toast("Reminder sent", "bell"); },
      cancel: async () => { if (confirm("Cancel this request?")) { await api.cancel(view.id); go("#/"); } },
      receipt: () => share(api.receiptUrl(view.receipt), "Paid ✓", `I paid you ${money(view.fiat_amount, view.fiat)} on ${B.name}`),
      own: () => { sessionStorage.removeItem(K("pending")); go("#/"); },
    });
    if (celebrate) { confetti(); navigator.vibrate?.([30, 40, 60]); }
  };
  draw();
  if (sessionStorage.getItem(K("autosim")) === view.id && !FINAL.has(view.status)) {
    sessionStorage.removeItem(K("autosim"));
    setTimeout(() => api.simulate(id, k, "ok").then(() => toast(`${DEMO_NAME} is paying…`, "play")).catch((e) => toast(e.message, "alert")), 900);
  }
  const off = api.subscribePay(id, k, (v) => { const changed = v.status !== view.status; view = v; if (changed) { draw(v.status === "paid"); if (v.status === "paid") toast("Paid"); } });
  cleanup.push(off);
}

async function screenReceipt(enc) {
  if (!api.applyReceipt || !api.hasUser()) return go("#/");
  const r = await api.applyReceipt(enc);
  mount(`<header class="bar">${mark()}<h1>Paid</h1></header>
    <div class="paycard is-paid">${splash()}
    <div class="who"><div class="title"><span class="yay">${esc(r.payer_name ?? "They")} paid you!</span></div></div>
    <p class="bigamt" data-fit="32">${esc(money(r.fiat_amount, r.fiat))}</p>
    <p class="center" style="margin:10px 0 0">${chip("paid", "Paid ✓", true, "pill")}</p></div>
    <a class="btn primary" href="#/" style="margin-top:20px">${icon("check")}Done</a>`);
  confetti();
}

// ---- settings --------------------------------------------------------------
function screenSettings() {
  const fiats = cfg.fiats.map((f) => `<option ${f === me.user.fiat ? "selected" : ""}>${f}</option>`).join("");
  const addr = cfg.assets.map((a) => `<label class="field"><span>${icon("wallet")}${esc(a.label)} · ${esc(a.network)}</span><input class="mono" name="addr:${esc(a.id)}" value="${esc(me.addresses[a.id] ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Not set"></label>`).join("");
  const n = "Notification" in window ? Notification.permission : "unsupported";
  mount(`
    ${bar("Settings")}
    <div class="who">${avatar(me.user.name, me.user.color, "lg ring-on")}<div class="title"><b>${esc(me.user.name)}</b></div></div>
    <div class="card setrow">${icon(theme() === "dark" ? "moon" : "sun")}<span class="lbl" id="dm">Dark mode<small>${theme() === "dark" ? "On" : "Off"}</small></span>
      <button class="toggle" type="button" role="switch" aria-checked="${theme() === "dark"}" aria-labelledby="dm" data-act="theme"></button></div>
    <form data-act="save">
      <label class="field"><span>${icon("pen")}Name</span><input name="name" value="${esc(me.user.name)}" maxlength="40" required></label>
      <label class="field"><span>${icon("globe")}Currency</span><select name="fiat">${fiats}</select></label>
      <h2>${icon("wallet")}Get paid to</h2>
      <p class="small muted" style="margin-top:-4px">Your own addresses (${cfg.mode === "api" ? "LIVE networks" : "test networks"}). Payers can't change them. Empty = not accepted.</p>
      ${cfg.demoAddresses ? `<button type="button" class="btn ghost" data-act="demoAddr">${icon("refresh")}Use the demo test wallets</button>` : ""}
      ${addr}
      <button class="btn primary" type="submit">${icon("check")}Save</button>
    </form>
    <h2>${icon("bell")}Notifications</h2>
    <div class="card setrow">${icon("bell")}<span class="lbl">Status<small>${esc(n)}${isIOS && !standalone ? " · add to Home Screen first" : ""}</small></span>
      ${n === "default" ? `<button class="btn secondary slim" data-act="notif">Turn on</button>` : ""}${n === "granted" ? `<button class="btn secondary slim" data-act="testPush">Test</button>` : ""}</div>
    <h2>${icon("log-out")}This device</h2>
    <button class="btn secondary" data-act="forget">${icon("trash")}Forget me here</button>
    <h2>${icon("info")}About</h2>
    <div class="card about">${wordmark()}<p class="muted small">${esc(B.tagline)} An open example app. Test money only.</p>
      <a class="small" href="${esc(B.codeUrl)}" rel="noopener">${icon("code", { size: 16 })}Source code</a>
      ${B.poweredBy ? `<p class="powered">powered by send21</p>` : ""}</div>
    ${footer()}`, {
    back: () => go("#/"),
    demoAddr: () => { for (const [id, v] of Object.entries(cfg.demoAddresses)) { const i = $app.querySelector(`[name="addr:${id}"]`); if (i) i.value = v; } },
    async save(f) {
      const addresses = {};
      for (const a of cfg.assets) addresses[a.id] = f[`addr:${a.id}`].value.trim();
      await api.updateMe({ name: f.name.value, fiat: f.fiat.value, addresses });
      toast("Saved");
      go("#/");
    },
    notif: enableNotifications,
    testPush: async () => { await api.testPush(); toast("Sent. It should arrive in a moment.", "bell"); },
    forget: () => { if (confirm("Forget your name and friends on this device?")) { api.forget(); location.hash = "#/"; location.reload(); } },
  });
}

// ---- desktop: a small landing beside the phone, with a QR to open it on a phone ----
function deskHero() {
  const el = document.getElementById("deskhero");
  if (!el) return;
  const url = location.href.split("#")[0].split("?")[0];
  el.innerHTML = `${wordmark()}
    <h1>${esc(B.tagline)}</h1>
    <ul>
      <li>${icon("arrow-down-left")}<span><b>Pay friends back.</b> Ask in your own money.</span></li>
      <li>${icon("split")}<span><b>Split a bill.</b> Everyone gets their share.</span></li>
      <li>${icon("qr")}<span><b>Show a QR.</b> Anyone can pay, no app needed.</span></li>
    </ul>
    <div class="openphone">${qrBox(url, `QR code to open ${B.name} on your phone`)}<div><b>Open it on your phone</b><span class="muted small">Scan with the camera. Or try it right here: tap “Try it alone with a demo friend”.</span></div></div>
    <p class="small muted">${icon("flask", { size: 16 })}Test money only. You sign in your own wallet; nobody here holds your keys or funds.</p>
    <p class="small"><a href="${esc(B.codeUrl)}" rel="noopener">${icon("code", { size: 16 })}Source code</a></p>`;
}

// ---- start -------------------------------------------------------------------
async function start() {
  cfg = await api.config();
  if (FORCED_DARK) document.documentElement.dataset.theme = "dark";
  const badge = document.querySelector(".testnet");
  badge.innerHTML = cfg.mode === "api"
    ? `<span>${icon("alert", { size: 14 })}LIVE · real money</span>`
    : `<span>${icon("flask", { size: 14 })}test mode</span><span class="sr"> · test money only, nothing here has value</span>`;
  if (cfg.mode === "api") badge.classList.add("live");
  setTheme(theme());
  deskHero();
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
  window.addEventListener("app-signed-in", connect);
  await render();
  connect();
}
start();
