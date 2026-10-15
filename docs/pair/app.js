import { ASSETS, FINAL, cryptoLine, fiatForLocale, formatFiat, initials, mockBaseUnits, networkOf, pickAsset, randomId, splitAmount, statusText } from "./lib/core.js";
import { serverApi } from "./lib/server-api.js";
import { staticApi } from "./lib/static-api.js";
import qrcode from "./vendor/qrcode.js";

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
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const touch = matchMedia("(pointer: coarse)").matches;
const logo = `<img class="logo" src="icons/logo.svg" alt="send21">`;

function avatar(name, color, cls = "") {
  return `<span class="avatar ${cls}" style="background:${esc(color ?? "#F7931A")}" aria-hidden="true">${esc(initials(name ?? "?"))}</span>`;
}
function qrSvg(text, label) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
  return `<div class="qr"><svg viewBox="-2 -2 ${n + 4} ${n + 4}" role="img" aria-label="${esc(label)}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#FEF8EC"/><path d="${d}" fill="#1B1C20"/></svg></div>`;
}
let toastTimer;
function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}
async function copy(text, what = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(`${what} ✓`); } catch { prompt("Copy this:", text); }
}
async function share(url, title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  copy(url, "Link copied");
}
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
    return screenHome();
  } catch (err) {
    if (err.status === 401) { api.forget(); return go("#/"); }
    $app.innerHTML = `<header class="bar">${logo}<h1>send21 pair</h1></header><div class="card"><p>${esc(err.message)}</p></div><p><a class="btn secondary" href="#/">Home</a></p>`;
  }
}
function mount(html, handlers = {}) {
  $app.innerHTML = html;
  $app.onclick = async (e) => {
    const el = e.target.closest("[data-act]");
    if (!el || !handlers[el.dataset.act]) return;
    e.preventDefault();
    try { await handlers[el.dataset.act](el, e); } catch (err) { toast(err.message); }
  };
  $app.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!handlers[f.dataset.act]) return;
    const b = f.querySelector("[type=submit]");
    if (b) b.disabled = true;
    try { await handlers[f.dataset.act](f, e); } catch (err) { toast(err.message); } finally { if (b && document.contains(b)) b.disabled = false; }
  };
  $app.oninput = (e) => handlers.input?.(e.target, e);
  window.scrollTo(0, 0);
}
const footer = () => `<footer class="foot">send21 pair · testnet prototype · ${cfg.static ? "runs in this browser (mock)" : `${esc(cfg.mode)} mode`}<br>The payer signs in their own wallet. send21 never holds keys or funds.<br><a href="mailto:info@send21.io">info@send21.io</a></footer>`;

// ---- onboarding ----------------------------------------------------------
function screenOnboarding() {
  const fiat = fiatForLocale(locale);
  const opts = cfg.fiats.map((f) => `<option ${f === fiat ? "selected" : ""}>${f}</option>`).join("");
  mount(`
    <div class="who" style="margin-top:20px">${logo.replace('class="logo"', 'class="logo" style="width:84px;height:84px"')}</div>
    <h1 class="center" style="font-size:30px;margin:12px 0 4px">send21 pair</h1>
    <p class="lead center">Ask friends for money. Pay them back.<br><span class="muted">You sign in your own wallet.</span></p>
    <form data-act="start" class="stack">
      <label class="field"><span>What should friends call you?</span><input name="name" autocomplete="nickname" maxlength="40" required placeholder="Your name"></label>
      <label class="field"><span>Your money</span><select name="fiat" aria-label="Currency">${opts}</select></label>
      <button class="btn primary big" type="submit">Start</button>
    </form>
    <p class="small muted center">No email, no password, no phone number. Test money only: your wallets are prefilled with the public send21 testnet demo wallets, change them in Settings.</p>
    ${footer()}`, {
    async start(f) {
      await api.signup({ name: f.name.value, fiat: f.fiat.value });
      toast(`Welcome, ${f.name.value.trim()}`);
      window.dispatchEvent(new Event("pair-signed-in"));
      render();
    },
  });
  $app.querySelector("input[name=name]").focus();
}

// ---- home ----------------------------------------------------------------
function activityItem(r) {
  const iGet = r.to_user === me.user.id;
  const other = iGet ? (r.from_user ? r.payer_name : "Anyone (link)") : r.receiver_name;
  const color = iGet ? r.payer_color ?? "#3A3B42" : r.receiver_color;
  const st = r.status;
  const label = r.kind === "link" ? "Pay link" : r.split_id ? `Split${r.split_title ? ` · ${r.split_title}` : ""}` : r.note || (iGet ? "Request" : r.kind === "send" ? "You pay" : "Asked you");
  return `<li><a href="${esc(r.pay_path.startsWith("#") ? r.pay_path : `#${r.pay_path}`)}">${avatar(other, color, "sm")}
    <span class="what"><b>${esc(other)}</b><span class="small muted">${esc(label)}</span></span>
    <span><span class="amt ${iGet && st === "paid" ? "in" : ""}">${iGet ? "+" : "−"}${esc(money(r.fiat_amount, r.fiat))}</span><br><span class="status ${st}">${esc(r.status_text)}</span></span></a></li>`;
}
function notices() {
  let out = "";
  if (!me.contacts.length) {
    out += `<div class="notice"><b>Start by adding someone.</b><br><span class="muted">Show them your code, or send them your link. When they open it, you're connected.</span><a class="btn primary" href="#/me">Show my code</a></div>`;
  } else if ("Notification" in window && Notification.permission === "default" && !localStorage.getItem("pair.notif.skip")) {
    if (isIOS && !standalone) {
      out += `<div class="notice"><b>Get told when someone asks or pays</b><br><span class="muted">On iPhone, notifications work after you add this app to your Home Screen: tap Share, then “Add to Home Screen”, then open it from there.</span></div>`;
    } else {
      out += `<div class="notice"><b>Get told when someone asks or pays</b><div class="row"><button class="btn primary" data-act="notif">Turn on</button><button class="btn secondary" data-act="notifSkip">Not now</button></div></div>`;
    }
  }
  return out;
}
function screenHome() {
  const people = me.contacts.map((c) => `<button class="contact" data-act="person" data-id="${esc(c.id)}">${avatar(c.name, c.color)}<span>${esc(c.name.split(" ")[0])}</span></button>`).join("");
  mount(`
    <header class="bar">${logo}<h1>Hi, ${esc(me.user.name.split(" ")[0])}</h1>
      <a class="iconbtn" href="#/me" aria-label="My code" style="display:grid;place-items:center;text-decoration:none">My code</a>
      <a class="iconbtn" href="#/settings" aria-label="Settings" style="display:grid;place-items:center;text-decoration:none">⚙</a></header>
    <div class="duo">
      <a class="btn primary" href="#/new?mode=request"><span aria-hidden="true">↓</span>Request</a>
      <a class="btn secondary" href="#/new?mode=pay"><span aria-hidden="true">↑</span>Pay</a>
    </div>
    ${notices()}
    <h2>People</h2>
    <div class="contacts"><a class="contact" href="#/me" aria-label="Add someone">${'<span class="avatar add" aria-hidden="true">+</span>'}<span>Add</span></a>${people}</div>
    <h2>Activity</h2>
    ${me.activity.length ? `<ul class="activity">${me.activity.map(activityItem).join("")}</ul>` : `<p class="muted">Nothing yet. Requests and payments show up here.</p>`}
    <p style="margin-top:22px"><a class="btn ghost" href="#/new?mode=link">Get paid by anyone with a QR code</a></p>
    ${footer()}`, {
    person: (el) => go(`#/new?mode=request&to=${el.dataset.id}`),
    notif: enableNotifications,
    notifSkip: () => { localStorage.setItem("pair.notif.skip", "1"); render(); },
  });
}

// ---- notifications ---------------------------------------------------------
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function enableNotifications() {
  if (!("Notification" in window)) return toast("This browser has no notifications");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Notifications are off. You can still use links."); return render(); }
  if (cfg.vapidPublicKey && "PushManager" in window && navigator.serviceWorker) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(cfg.vapidPublicKey) }));
      await api.savePush(sub.toJSON());
      localStorage.setItem(`pair.push.${slot}`, "1");
    } catch (err) {
      toast(`Push not available here (${err.message}). You'll still be told while the app is open.`);
    }
  }
  toast("Notifications on ✓");
  render();
}
async function localNotify(n) {
  // With real push the service worker shows it. Without push, show it ourselves
  // when the app is in the background, else a toast.
  if (document.visibilityState === "visible" || Notification?.permission !== "granted" || localStorage.getItem(`pair.push.${slot}`)) {
    if (document.visibilityState === "visible") toast(`${n.title}${n.body ? ` · ${n.body}` : ""}`);
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
    <header class="bar"><button class="back" data-act="back" aria-label="Back">‹</button><h1>Add someone</h1></header>
    <div class="who">${avatar(me.user.name, me.user.color, "lg")}<div class="title">${esc(me.user.name)}</div></div>
    <p class="center muted">Let them scan this with their phone camera.</p>
    ${qrSvg(url, `QR code to add ${me.user.name}`)}
    <div class="stack">
      <button class="btn primary" data-act="share">Send my link</button>
      ${canScan ? `<button class="btn secondary" data-act="scan">Scan their code</button><video class="scan" hidden playsinline muted></video>` : `<p class="center small muted">To add someone else, point your camera app at their code.</p>`}
    </div>
    <details><summary>Show the link</summary><p class="linkbox">${esc(url)}</p>
      ${cfg.static ? `<p class="small muted">On this demo the link itself carries your name and test wallets. There's no server, so the other phone adds you, and you scan theirs to add them back.</p>` : `<button class="btn ghost" data-act="reset">Make a new link (the old one stops working)</button>`}
    </details>
    ${footer()}`, {
    back: () => history.length > 1 ? history.back() : go("#/"),
    share: () => share(url, "Add me on send21 pair", `Add me on send21 pair so we can pay each other back.`),
    async reset() { await api.resetPairCode(); toast("New link made"); render(); },
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
    return mount(`<header class="bar">${logo}<h1>send21 pair</h1></header><div class="card">${esc(err.message)}</div><p><a class="btn secondary" href="#/">Home</a></p>`);
  }
  const first = info.name.split(" ")[0];
  mount(`
    <header class="bar">${logo}<h1>send21 pair</h1></header>
    <div class="who" style="margin-top:30px">${avatar(info.name, info.color, "lg")}<div class="title">Add <b>${esc(info.name)}</b>?</div>
      <p class="muted">You'll be able to ask each other for money and pay each other back.</p></div>
    <div class="stack" style="margin-top:20px">
      <button class="btn primary big" data-act="add">Add ${esc(first)}</button>
      <a class="btn secondary" href="#/">Not now</a>
    </div>`, {
    async add() {
      const r = await api.addContact(code);
      toast(r.already ? `${first} is already in your people` : `${first} added ✓`);
      if (r.oneWay) {
        mount(`<header class="bar">${logo}<h1>send21 pair</h1></header>
          <div class="who" style="margin-top:20px">${avatar(info.name, info.color, "lg")}<div class="title">${esc(first)} added ✓</div></div>
          <div class="notice">This demo has no server. Show ${esc(first)} your code so they can add you too.</div>
          <div class="stack"><a class="btn primary" href="#/me">Show my code</a><a class="btn secondary" href="#/">Done</a></div>`);
      } else go("#/");
    },
  });
}

// ---- request / pay ---------------------------------------------------------
function screenNew(query) {
  let mode = query.get("mode") ?? "request"; // request | pay | link
  const selected = new Set(query.get("to") ? [query.get("to")] : []);
  let includeMe = true;
  const myFiat = me.user.fiat;
  const titles = { request: "Request", pay: "Pay", link: "Get paid with a QR" };

  const draw = () => {
    const people = me.contacts.map((c) => `<button type="button" class="contact" data-act="pick" data-id="${esc(c.id)}" aria-pressed="${selected.has(c.id)}">${avatar(c.name, c.color)}<span>${esc(c.name.split(" ")[0])}</span></button>`).join("");
    const seg = mode === "link" ? "" : `<div class="row" role="group" aria-label="Request or pay" style="margin-bottom:6px">
        <button type="button" class="btn ${mode === "request" ? "primary" : "secondary"}" data-act="mode" data-m="request" aria-pressed="${mode === "request"}" style="min-height:48px;font-size:17px">Request</button>
        <button type="button" class="btn ${mode === "pay" ? "primary" : "secondary"}" data-act="mode" data-m="pay" aria-pressed="${mode === "pay"}" style="min-height:48px;font-size:17px">Pay</button></div>`;
    mount(`
      <header class="bar"><button class="back" type="button" data-act="back" aria-label="Back">‹</button><h1>${titles[mode]}</h1></header>
      ${seg}
      <form data-act="submit">
        ${mode === "link" ? `<p class="muted">Anyone can pay this: they scan the code with their phone, a page opens, they tap “Open wallet”. No app needed.</p>` : `
        <h2>${mode === "request" ? "From" : "To"}${mode === "request" ? ` <span class="small" style="text-transform:none;letter-spacing:0">(pick several to split)</span>` : ""}</h2>
        ${me.contacts.length ? `<div class="contacts">${people}</div>` : `<div class="notice">Add someone first. <a href="#/me">Show my code</a></div>`}`}
        <div class="amount"><label class="sr" for="amt">Amount in ${myFiat}</label><input id="amt" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(query.get("amount") ?? "")}"><span class="ccy">${myFiat}</span></div>
        <p class="crypto" id="crypto"></p>
        <label class="field"><span>What's it for? (optional)</span><input name="note" maxlength="80" placeholder="Pizza, taxi, rent…" value="${esc(query.get("note") ?? "")}"></label>
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
  function update() {
    const amt = amountVal();
    const n = mode === "request" ? selected.size : 1;
    const parts = mode === "request" && n > 1 ? n + (includeMe ? 1 : 0) : 1;
    const share = parts > 1 ? splitAmount(amt, parts)[0] : amt;
    const accepts = mode === "pay" ? target()?.accepts ?? [] : Object.keys(me.addresses);
    const asset = pickAsset(accepts, myFiat, cfg.mode);
    const $c = $app.querySelector("#crypto");
    if (mode === "pay" && !target()) $c.textContent = "Pick who to pay";
    else if (!asset) $c.textContent = mode === "pay" ? `${target().name} hasn't added a wallet yet` : "Add a wallet address in Settings first";
    else if (cfg.mode === "demo") $c.textContent = `Testnet demo: send21 sets a fixed test amount (about 0.10 USD) in ${ASSETS[asset].label} on ${networkOf(asset, "demo").name}`;
    else if (cfg.mode === "api") $c.textContent = `Paid in ${ASSETS[asset].label} on ${networkOf(asset, "api").name}. send21 locks the rate.`;
    else if (share > 0) { const c = cryptoLine(mockBaseUnits(share, myFiat, asset), asset, "mock"); $c.textContent = `≈ ${c.amount} ${c.symbol} · ${c.network} (mock rate)`; }
    else $c.textContent = `Paid in ${ASSETS[asset].label} on ${networkOf(asset, cfg.mode).name}`;
    const $s = $app.querySelector("#split");
    $s.innerHTML = parts > 1 || (mode === "request" && n > 1) ? `<div class="card"><label style="display:flex;gap:10px;align-items:center;min-height:44px"><input type="checkbox" id="inc" ${includeMe ? "checked" : ""} style="width:24px;min-height:24px"> I had a share too</label>
      <p style="margin:6px 0 0">Split ${parts} ways: <b>${esc(money(share, myFiat))}</b> each from ${n} ${n === 1 ? "person" : "people"}</p></div>` : "";
    const names = [...selected].map((id) => me.contacts.find((c) => c.id === id)?.name.split(" ")[0]).filter(Boolean);
    const $go = $app.querySelector("#go");
    const amtText = amt > 0 ? money(parts > 1 ? share : amt, myFiat) : "";
    $go.textContent = mode === "link" ? `Show QR${amtText ? ` for ${amtText}` : ""}`
      : mode === "pay" ? (names[0] ? `Pay ${names[0]}${amtText ? ` ${amtText}` : ""}` : "Pay")
      : names.length > 1 ? `Request ${amtText} each` : names[0] ? `Request ${amtText} from ${names[0]}` : "Request";
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
  const rows = items.map((r) => `<div class="card" style="display:flex;align-items:center;gap:12px">${avatar(r.payer_name, r.payer_color, "sm")}
      <div style="flex:1"><b>${esc(r.payer_name)}</b><br><span class="status ${r.status}">${esc(r.status_text)}</span></div>
      <div style="text-align:right"><b>${esc(money(r.fiat_amount, r.fiat))}</b><br><button class="btn ghost" style="min-height:36px;padding:0" data-act="share" data-url="${esc(api.payUrl(r))}" data-name="${esc(r.payer_name)}">${cfg.static ? "Send link" : "Share link"}</button></div></div>`).join("");
  mount(`
    <header class="bar">${logo}<h1>Request sent</h1></header>
    <div class="done" aria-hidden="true">✓</div>
    <p class="lead center">${cfg.static ? "Now send them the link. It opens a page where they tap “Open wallet”." : `${items.length > 1 ? "They get" : `${esc(items[0]?.payer_name ?? "They")} gets`} a notification. You'll see “Paid ✓” here.`}</p>
    ${rows}
    <p class="small muted center">${cfg.static ? "" : "No notifications on their phone? Share the link, it works in any browser."}</p>
    <a class="btn primary" href="#/" style="margin-top:16px">Done</a>`, {
    share: (el) => share(el.dataset.url, "send21 pair", `${me.user.name} asks you for money on send21 pair`),
  });
}

// ---- the pay screen (works without the app and without a name) -------------
async function screenPay(id, k) {
  let view = await api.payInfo(id, k);
  if (cfg.static && !api.hasUser()) { /* a payer without the app: fine */ }
  if (api.hasUser() && !me) me = await api.me().catch(() => null);
  const draw = () => {
    const mine = me && view.receiver.id === me.user.id;
    const first = view.receiver.name.split(" ")[0];
    const c = view.crypto;
    const paid = view.status === "paid";
    const final = FINAL.has(view.status);
    const head = mine
      ? (view.kind === "link" ? "Show this to the person paying" : view.kind === "send" ? `${esc(view.payer?.name)} is sending you` : `You asked ${esc(view.payer?.name ?? "")} for`)
      : view.kind === "send" ? `Pay ${esc(view.receiver.name)}` : `${esc(view.receiver.name)} asks for`;
    const pageUrl = cfg.static ? api.payUrl({ pay_path: `#/r/${id}` }) : new URL(`r/${view.id}?k=${encodeURIComponent(k)}`, location.href.split("#")[0].split("?")[0]).href;
    const statusLine = mine
      ? statusText({ status: view.status, to_user: view.receiver.id, from_user: view.payer?.id ?? null, payer_name: view.payer?.name }, me.user.id)
      : view.status_text;
    const cryptoText = c ? `≈ ${c.amount} ${c.symbol} on ${c.network}` : `${view.asset_label} on ${view.network}`;
    const walletBtn = view.payment_uri
      ? `<a class="btn primary big" href="${esc(view.payment_uri)}" data-act="wallet">Open wallet</a>`
      : view.pay_url ? `<a class="btn primary big" href="${esc(view.pay_url)}" rel="noopener">Open pay page</a>` : "";
    const payerPart = final ? "" : `
      <div class="stack" style="margin-top:18px">${walletBtn}</div>
      <p class="small muted center" style="margin:8px 0 0">Your wallet opens with the amount and address filled in. Check them, then sign.</p>
      ${view.payment_uri ? `<details ${touch ? "" : "open"}><summary>Paying from another device? Scan with your wallet</summary>${qrSvg(view.payment_uri, "Wallet QR code")}</details>
      <div class="row" style="margin-top:6px"><button class="btn ghost" data-act="copyAddr">Copy address</button><button class="btn ghost" data-act="copyAmt">Copy amount</button></div>` : ""}
      ${view.source === "mock" || view.source === "static" ? `<div class="notice small"><b>Mock mode.</b> No real payment is needed: <button class="btn secondary" data-act="sim">Simulate payment</button><button class="btn ghost" data-act="simBad">Simulate a wrong amount</button></div>` : ""}
      ${view.source === "demo" ? `<div class="notice small"><b>send21 testnet demo.</b> The wallet amount is send21's fixed test amount and it goes to send21's demo wallet, not to ${esc(first)}. Test coins: <a href="https://faucet.solana.com" rel="noopener">faucet.solana.com</a>, <a href="https://faucet.circle.com" rel="noopener">faucet.circle.com</a>.</div>` : ""}`;
    const receiverPart = final ? "" : `
      ${view.kind === "link" || view.kind === "request" ? `${qrSvg(pageUrl, "QR code of the pay page")}<p class="center small muted">They scan it with their phone camera. A page opens, they tap “Open wallet”.</p>` : ""}
      <div class="stack">
        ${view.kind !== "send" ? `<button class="btn primary" data-act="share">Share the link</button>` : ""}
        ${view.payer && view.kind === "request" && !cfg.static ? `<button class="btn secondary" data-act="remind">Remind ${esc(view.payer.name.split(" ")[0])}</button>` : ""}
        ${view.source === "mock" || view.source === "static" ? `<button class="btn ghost" data-act="sim">Testing alone? Simulate the payer</button>` : ""}
        ${view.kind !== "send" ? `<button class="btn ghost" data-act="cancel">Cancel request</button>` : ""}
      </div>`;
    const receipt = cfg.static && paid && !mine && view.receipt && view.payer
      ? `<div class="notice">This demo has no server. Let ${esc(first)} know: <button class="btn primary" data-act="receipt">Send ${esc(first)} the receipt</button></div>` : "";
    mount(`
      <header class="bar">${me ? `<button class="back" data-act="back" aria-label="Back">‹</button>` : logo}<h1>${mine ? "Your request" : "Pay"}</h1></header>
      <div class="who">${mine ? (view.payer ? avatar(view.payer.name, view.payer.color ?? "#FEF8EC", "lg") : avatar(me.user.name, me.user.color, "lg")) : avatar(view.receiver.name, view.receiver.color, "lg")}<div class="title">${head}</div></div>
      <p class="bigamt">${esc(money(view.fiat_amount, view.fiat))}</p>
      <p class="crypto">${esc(cryptoText)}${view.testnet ? " · testnet" : ""}</p>
      ${view.note ? `<p class="center">“${esc(view.note)}”</p>` : ""}
      <p class="center"><span class="pill ${view.status}" role="status">${esc(statusLine)}</span></p>
      ${paid ? `<div class="done" aria-hidden="true">✓</div>${view.tx_id ? `<p class="center small muted">Transaction ${esc(view.tx_id.slice(0, 18))}…</p>` : ""}` : ""}
      ${view.review_note ? `<div class="notice small">${esc(view.review_note)}</div>` : ""}
      ${receipt}
      ${mine ? receiverPart : payerPart}
      ${!api.hasUser() ? `<div class="card" style="margin-top:24px"><b>Want your own?</b><p class="muted small">Ask friends for money and pay them back, in your own currency.</p><a class="btn secondary" href="#/" data-act="own">Get send21 pair</a></div>` : ""}
      ${footer()}`, {
      back: () => go("#/"),
      wallet: (el) => { location.href = el.getAttribute("href"); },
      copyAddr: () => copy(view.receiver_address, "Address copied"),
      copyAmt: () => copy(c?.exact ?? "", "Amount copied"),
      sim: async () => { await api.simulate(id, k, "ok"); toast("Payment sent (simulated)"); },
      simBad: async () => { await api.simulate(id, k, "wrong_amount"); toast("Wrong amount sent (simulated)"); },
      share: () => share(pageUrl, "send21 pair", `${view.receiver.name} asks for ${money(view.fiat_amount, view.fiat)}${view.note ? ` for ${view.note}` : ""}`),
      remind: async () => { await api.remind(view.id); toast("Reminder sent"); },
      cancel: async () => { if (confirm("Cancel this request?")) { await api.cancel(view.id); go("#/"); } },
      receipt: () => share(api.receiptUrl(view.receipt), "Paid ✓", `I paid you ${money(view.fiat_amount, view.fiat)} on send21 pair`),
      own: () => { sessionStorage.removeItem("pair.pending"); go("#/"); },
    });
  };
  draw();
  const off = api.subscribePay(id, k, (v) => { const changed = v.status !== view.status; view = v; if (changed) { draw(); if (v.status === "paid") toast("Paid ✓"); } });
  cleanup.push(off);
}

async function screenReceipt(enc) {
  if (!api.applyReceipt || !api.hasUser()) return go("#/");
  const r = await api.applyReceipt(enc);
  mount(`<header class="bar">${logo}<h1>Paid</h1></header>
    <div class="who">${avatar(r.payer_name ?? "?", r.payer_color ?? "#FEF8EC", "lg")}<div class="title">${esc(r.payer_name ?? "They")} paid you</div></div>
    <p class="bigamt">${esc(money(r.fiat_amount, r.fiat))}</p><div class="done" aria-hidden="true">✓</div>
    <a class="btn primary" href="#/">Done</a>`);
}

// ---- settings --------------------------------------------------------------
function screenSettings() {
  const fiats = cfg.fiats.map((f) => `<option ${f === me.user.fiat ? "selected" : ""}>${f}</option>`).join("");
  const addr = cfg.assets.map((a) => `<label class="field"><span>${esc(a.label)} on ${esc(a.network)}</span><input class="mono" name="addr:${esc(a.id)}" value="${esc(me.addresses[a.id] ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Not set"></label>`).join("");
  const n = "Notification" in window ? Notification.permission : "unsupported";
  mount(`
    <header class="bar"><button class="back" data-act="back" aria-label="Back">‹</button><h1>Settings</h1></header>
    <form data-act="save">
      <label class="field"><span>Your name</span><input name="name" value="${esc(me.user.name)}" maxlength="40" required></label>
      <label class="field"><span>Your money</span><select name="fiat">${fiats}</select></label>
      <h2>Where you get paid</h2>
      <p class="small muted">Your own receive addresses (${cfg.mode === "api" ? "LIVE networks" : "test networks"}). People who pay you can't change them. Leave one empty if you don't accept that asset. The app picks the cheapest one you accept.</p>
      ${cfg.demoAddresses ? `<button type="button" class="btn ghost" data-act="demoAddr">Use the public send21 testnet demo wallets</button>` : ""}
      ${addr}
      <button class="btn primary" type="submit">Save</button>
    </form>
    <h2>Notifications</h2>
    <p class="muted small">Now: ${esc(n)}.${isIOS && !standalone ? " On iPhone, add the app to your Home Screen first." : ""}</p>
    <div class="stack">${n === "default" ? `<button class="btn secondary" data-act="notif">Turn on</button>` : ""}${n === "granted" ? `<button class="btn secondary" data-act="testPush">Send me a test</button>` : ""}</div>
    <h2>This device</h2>
    <button class="btn ghost" data-act="forget">Forget me on this device</button>
    ${footer()}`, {
    back: () => go("#/"),
    demoAddr: () => { for (const [id, v] of Object.entries(cfg.demoAddresses)) { const i = $app.querySelector(`[name="addr:${id}"]`); if (i) i.value = v; } },
    async save(f) {
      const addresses = {};
      for (const a of cfg.assets) addresses[a.id] = f[`addr:${a.id}`].value.trim();
      await api.updateMe({ name: f.name.value, fiat: f.fiat.value, addresses });
      toast("Saved ✓");
      go("#/");
    },
    notif: enableNotifications,
    testPush: async () => { await api.testPush(); toast("Sent. It should arrive in a moment."); },
    forget: () => { if (confirm("Forget your name and contacts on this device?")) { api.forget(); location.hash = "#/"; location.reload(); } },
  });
}

// ---- start -------------------------------------------------------------------
async function start() {
  cfg = await api.config();
  if (cfg.mode === "api") document.querySelector(".testnet").innerHTML = "<strong>LIVE NETWORKS</strong> · real money";
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
