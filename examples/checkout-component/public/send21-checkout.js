// <send21-checkout> — a drop-in checkout widget for send21 pay links.
// Vanilla JS, one ES module, no build step, no dependencies.
//
//   <script type="module" src="/send21-checkout.js"></script>
//   <send21-checkout order-id="ord_..." amount="47.00" currency="EUR"></send21-checkout>
//
// It talks only to YOUR shop backend (never to send21, never with a key):
//   POST {endpoint}                    { orderId, amount, currency } -> pay link view
//   GET  {endpoint}/{orderId}/status   -> { status, txId?, expiresAt, ... }
// and fires DOM events (bubbling, composed):
//   send21:ready   detail: the pay link view (payUrl, assets, expiresAt)
//   send21:status  detail: { orderId, status }
//   send21:paid    detail: { orderId, txId }
//   send21:expired detail: { orderId }
//   send21:error   detail: { orderId, message }
//
// The payer opens the pay link, picks an asset and signs in their own wallet.
// send21 is non-custodial: it never holds keys or funds.
//
// Theme with CSS custom properties on the element (defaults: send21 brand):
//   --send21-bg #1B1C20 (charcoal)   --send21-fg #FEF8EC (cream)
//   --send21-accent #F7931A (orange) --send21-accent-fg #1B1C20
//   --send21-muted, --send21-border, --send21-radius, --send21-font,
//   --send21-qr-size, --send21-padding, --send21-max-width
// and style inner parts with ::part(container | title | amount | qr | pay-button |
// copy-button | assets | asset | status | note | retry-button).

const STYLE = `
:host {
  --_bg: var(--send21-bg, #1B1C20);
  --_fg: var(--send21-fg, #FEF8EC);
  --_accent: var(--send21-accent, #F7931A);
  --_accent-fg: var(--send21-accent-fg, #1B1C20);
  --_muted: var(--send21-muted, color-mix(in srgb, var(--_fg) 72%, var(--_bg)));
  --_border: var(--send21-border, color-mix(in srgb, var(--_fg) 18%, var(--_bg)));
  --_radius: var(--send21-radius, 14px);
  --_qr: var(--send21-qr-size, 208px);
  display: block;
  max-width: var(--send21-max-width, 380px);
  font-family: var(--send21-font, Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
  color: var(--_fg);
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; }
.box {
  background: var(--_bg); color: var(--_fg);
  border: 1px solid var(--_border); border-radius: var(--_radius);
  padding: var(--send21-padding, 20px);
  display: grid; gap: 14px;
}
header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
h2 { margin: 0; font-size: 1.05rem; font-weight: 650; }
.brand { font-weight: 700; font-size: .85rem; letter-spacing: .01em; }
.brand b { color: var(--_accent); }
.amount { margin: 0; font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.qr { justify-self: center; width: var(--_qr); height: var(--_qr); border-radius: 10px; background: var(--_fg); padding: 6px; display: grid; place-items: center; }
.qr img { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
.qr[hidden], [hidden] { display: none !important; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn {
  appearance: none; border: 2px solid var(--_accent); border-radius: calc(var(--_radius) - 4px);
  padding: 10px 14px; font: inherit; font-weight: 650; cursor: pointer; text-decoration: none;
  display: inline-flex; align-items: center; justify-content: center; min-height: 44px;
}
.primary { background: var(--_accent); color: var(--_accent-fg); flex: 1 1 auto; }
.secondary { background: transparent; color: var(--_fg); border-color: var(--_border); }
.btn:hover { filter: brightness(1.06); }
.btn:focus-visible, a:focus-visible { outline: 3px solid var(--_fg); outline-offset: 2px; }
.assets-label { margin: 0 0 6px; font-size: .85rem; color: var(--_muted); }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
li { border: 1px solid var(--_border); border-radius: 999px; padding: 4px 10px; font-size: .85rem; }
.status { margin: 0; display: flex; align-items: center; gap: 8px; font-weight: 600; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--_accent); flex: none; }
.waiting .dot { animation: pulse 1.4s ease-in-out infinite; }
.paid .dot { background: var(--_accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--_accent) 30%, transparent); }
.expired .dot, .error .dot { background: var(--_muted); }
@keyframes pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .waiting .dot { animation: none; } }
.note { margin: 0; font-size: .8rem; color: var(--_muted); line-height: 1.4; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

const TEMPLATE = `
<section class="box" part="container" role="region" aria-labelledby="t" aria-busy="true">
  <header>
    <h2 id="t" part="title">Pay with crypto</h2>
    <span class="brand" aria-label="send21">send<b>21</b></span>
  </header>
  <p class="amount" part="amount"><span class="sr">Amount: </span><span id="amount"></span></p>
  <div class="qr" part="qr" hidden><img id="qr" alt="" width="200" height="200"></div>
  <div class="actions">
    <a class="btn primary" part="pay-button" id="pay" target="_blank" rel="noopener noreferrer" hidden>Open pay page<span class="sr"> (opens in a new tab)</span></a>
    <button class="btn secondary" part="copy-button" id="copy" type="button" hidden>Copy link</button>
    <button class="btn secondary" part="retry-button" id="retry" type="button" hidden>Try again</button>
  </div>
  <div id="assets-wrap" hidden>
    <p class="assets-label" id="assets-label">You can pay with</p>
    <ul part="assets" id="assets" aria-labelledby="assets-label"></ul>
  </div>
  <p class="status waiting" part="status" id="status" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><span id="status-text">Preparing your pay link…</span></p>
  <p class="note" part="note" id="note">Scan the QR code or open the pay page, pick an asset and sign in your own wallet. The payment goes straight to the shop; send21 never holds keys or funds.</p>
</section>`;

const TERMINAL = new Set(["paid", "expired"]);
const MESSAGES = {
  created: "Preparing your pay link…",
  awaiting_payment: "Waiting for your payment…",
  seen: "Payment seen, waiting for confirmation…",
  paid: "Paid. Thank you!",
  expired: "This pay link has expired.",
  review: "Payment received, the shop is reviewing it.",
};

let sheet;
function styles(root) {
  if ("adoptedStyleSheets" in Document.prototype && "replaceSync" in CSSStyleSheet.prototype) {
    if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(STYLE); }
    root.adoptedStyleSheets = [sheet];
  } else {
    const style = document.createElement("style");
    style.textContent = STYLE;
    root.append(style);
  }
}

const safeUrl = (value, base) => {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch { return null; }
};

export class Send21Checkout extends HTMLElement {
  static observedAttributes = ["order-id", "amount", "currency", "endpoint"];

  #root; #els = {}; #visible = () => this.#onVisible(); #timer = null; #abort = null; #status = null; #view = null; #errors = 0; #started = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    styles(this.#root);
    const tpl = document.createElement("template");
    tpl.innerHTML = TEMPLATE;
    this.#root.append(tpl.content.cloneNode(true));
    for (const id of ["amount", "qr", "pay", "copy", "retry", "assets", "assets-wrap", "status", "status-text"]) this.#els[id] = this.#root.getElementById(id);
    this.#els.box = this.#root.querySelector(".box");
    this.#els.copy.addEventListener("click", () => this.#copy());
    this.#els.retry.addEventListener("click", () => this.#start());
  }

  get orderId() { return this.getAttribute("order-id") ?? ""; }
  get endpoint() { return (this.getAttribute("endpoint") || "/checkout").replace(/\/$/, ""); }
  get pollInterval() { return Math.max(1000, Number(this.getAttribute("poll-interval")) || 3000); }
  /** Current status: created, awaiting_payment, seen, paid, review, expired or null. */
  get status() { return this.#status; }

  connectedCallback() {
    document.addEventListener("visibilitychange", this.#visible);
    if (this.orderId && !this.#started) this.#start();
  }
  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.#visible);
    this.#stop();
    this.#started = false;
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    if (name === "order-id" || name === "endpoint") this.#start();
    else this.#renderAmount();
  }

  #onVisible() {
    if (document.visibilityState === "visible" && this.#view && !TERMINAL.has(this.#status)) this.#schedule(0);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(`send21:${type}`, { detail, bubbles: true, composed: true }));
  }

  #stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  #renderAmount(value = this.getAttribute("amount"), currency = this.getAttribute("currency")) {
    const n = Number(value);
    let text = value ?? "";
    if (Number.isFinite(n) && currency) {
      try { text = new Intl.NumberFormat(this.getAttribute("locale") || undefined, { style: "currency", currency }).format(n); }
      catch { text = `${n.toFixed(2)} ${currency}`; }
    }
    this.#els.amount.textContent = text;
  }

  async #start() {
    this.#stop();
    this.#started = true;
    this.#status = null;
    this.#view = null;
    this.#errors = 0;
    this.#renderAmount();
    this.#setStatus("created");
    this.#els.retry.hidden = true;
    this.#els.box.setAttribute("aria-busy", "true");
    const abort = (this.#abort = new AbortController());
    try {
      const body = { orderId: this.orderId };
      if (this.hasAttribute("amount")) body.amount = Number(this.getAttribute("amount"));
      if (this.hasAttribute("currency")) body.currency = this.getAttribute("currency");
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        signal: abort.signal,
      });
      const view = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(view.error || `checkout failed (${res.status})`);
      this.#view = view;
      this.#renderView(view);
      this.#emit("ready", view);
      this.#apply(view);
    } catch (e) {
      if (e.name !== "AbortError") this.#fail(e.message);
    } finally {
      this.#els.box.setAttribute("aria-busy", "false");
    }
  }

  #renderView(view) {
    this.#renderAmount(view.fiatAmount, view.fiatCurrency);
    const href = safeUrl(view.payUrl, location.href);
    this.#els.pay.hidden = !href;
    this.#els.copy.hidden = !href || !navigator.clipboard;
    if (href) this.#els.pay.href = href;
    const qr = typeof view.qr === "string" && view.qr.startsWith("data:image/") ? view.qr : null;
    this.#els.qr.parentElement.hidden = !qr;
    if (qr) {
      this.#els.qr.src = qr;
      this.#els.qr.alt = "QR code of the pay link. Scan it with your wallet or phone camera.";
    }
    const list = this.#els.assets;
    list.replaceChildren(...(view.assets ?? []).map((a) => {
      const li = document.createElement("li");
      li.setAttribute("part", "asset");
      li.textContent = a.label ?? `${a.currency} on ${a.network}`;
      return li;
    }));
    this.#els["assets-wrap"].hidden = list.children.length === 0;
  }

  #setStatus(status, text = MESSAGES[status] ?? status) {
    const el = this.#els.status;
    el.className = `status ${status === "paid" ? "paid" : status === "expired" ? "expired" : status === "error" ? "error" : "waiting"}`;
    this.#els["status-text"].textContent = text;
  }

  #apply(view) {
    const changed = view.status !== this.#status;
    this.#status = view.status;
    this.#setStatus(view.status);
    if (changed) this.#emit("status", { orderId: this.orderId, status: view.status });
    if (view.status === "paid") {
      this.#stop();
      this.#els.pay.hidden = true;
      this.#els.copy.hidden = true;
      this.#els.qr.parentElement.hidden = true;
      if (changed) this.#emit("paid", { orderId: this.orderId, txId: view.txId ?? null });
      return;
    }
    if (view.status === "expired") {
      this.#stop();
      this.#els.pay.hidden = true;
      this.#els.copy.hidden = true;
      this.#els.qr.parentElement.hidden = true;
      this.#els.retry.hidden = false;
      if (changed) this.#emit("expired", { orderId: this.orderId });
      return;
    }
    this.#schedule(this.pollInterval);
  }

  #schedule(ms) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#poll(), ms);
  }

  async #poll() {
    const abort = (this.#abort = new AbortController());
    try {
      const res = await fetch(`${this.endpoint}/${encodeURIComponent(this.orderId)}/status`, {
        headers: { accept: "application/json" }, credentials: "same-origin", signal: abort.signal, cache: "no-store",
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      this.#errors = 0;
      this.#apply(await res.json());
    } catch (e) {
      if (e.name === "AbortError") return;
      // Back off on network errors, up to 30 s, and keep the current state.
      this.#errors += 1;
      this.#schedule(Math.min(30_000, this.pollInterval * 2 ** this.#errors));
    }
  }

  async #copy() {
    try {
      await navigator.clipboard.writeText(this.#els.pay.href);
      this.#els.copy.textContent = "Copied";
      setTimeout(() => { this.#els.copy.textContent = "Copy link"; }, 2000);
    } catch { /* clipboard blocked; the link is still clickable */ }
  }

  #fail(message) {
    this.#setStatus("error", `Could not load the payment: ${message}`);
    this.#els.retry.hidden = false;
    this.#emit("error", { orderId: this.orderId, message });
  }
}

if (!customElements.get("send21-checkout")) customElements.define("send21-checkout", Send21Checkout);
