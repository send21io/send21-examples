const app = document.getElementById("app");
const ICON = {
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  eye: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  wallet: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2"/><path d="M3 9h18"/></svg>',
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n, cur) => new Intl.NumberFormat("en", { style: "currency", currency: cur }).format(n);
const chunks = (a) => (String(a).match(/.{1,4}/g) ?? []);
const addrGrid = (a, label) => `<div class="addr" role="group" aria-label="${esc(label)}: ${esc(chunks(a).join(" "))}">${chunks(a).map((c) => `<span>${esc(c)}</span>`).join("")}</div>`;
const asset = (p) => `${p.currency.toUpperCase()} · ${p.network}`;
const initials = (s) => s.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function focusHeading() { app.querySelector("h1")?.setAttribute("tabindex", "-1"); app.querySelector("h1")?.focus({ preventScroll: true }); }

function stepper(state) {
  const steps = [
    ["created", "Draft created", "From your approved payee"],
    ["waiting", "Waiting for your signature", "In your own wallet"],
    ["paid", "Paid", "Confirmed on-chain"],
  ];
  const at = { created: 0, waiting: 1, paid: 3 }[state];
  return `<ol class="stepper" aria-label="Payment progress">${steps.map(([k, t, s], i) => {
    const cls = i < at ? "done" : i === at ? "active" : "";
    return `<li class="step ${cls}" ${i === at ? 'aria-current="step"' : ""}><b>${t}</b><small>${s}</small></li>`;
  }).join("")}</ol>`;
}

let payee, approval;

async function start() {
  try {
    ({ payee, approval } = await api("/api/payee"));
    renderPayee();
  } catch (e) { app.innerHTML = `<h1>Something is not set up yet</h1><p class="error">${esc(e.message)}</p>`; }
}

function sourceLine() {
  return approval.verified
    ? `${ICON.shield}<span><b>Verified in your send21 address book</b> on ${new Date(approval.verifiedAt).toLocaleDateString("en", { dateStyle: "medium" })}. Every payment uses this record.</span>`
    : `${ICON.shield}<span><b>Approved by you, saved in this app's payee file.</b> ${esc(approval.note)}</span>`;
}

function renderPayee() {
  const month = new Date(payee.month + "-01T12:00:00Z").toLocaleDateString("en", { month: "long", year: "numeric" });
  app.innerHTML = `
    <section class="fade-in">
      <p class="eyebrow">Monthly payment · ${esc(month)}</p>
      <h1>Pay ${esc(payee.label.toLowerCase())}</h1>
      <p class="lede">Same payee every month. The address comes from the record you approved once, never from your wallet history.</p>
      <article class="card" aria-labelledby="payee-name">
        <div class="card-head">
          <div class="avatar" aria-hidden="true">${esc(initials(payee.label))}</div>
          <div><div class="who" id="payee-name">${esc(payee.label)}</div><div class="meta">Approved payee</div></div>
          <div class="chips"><span class="chip">${esc(asset(payee))}</span><span class="chip">${esc(money(payee.fiatAmount, payee.fiatCurrency))} / month</span></div>
        </div>
        <div class="addr-label"><h2 style="margin:0">Receiving address</h2><span>${payee.address.length} characters</span></div>
        ${addrGrid(payee.address, "Approved receiving address")}
        <p class="source">${sourceLine()}</p>
        <div class="actions">
          <button class="btn btn-primary" id="create">Create this month's payment</button>
          <p class="fine">Nothing moves until you sign in your wallet.</p>
        </div>
      </article>
      <div class="limits"><p>This removes one risky step: copying an address from your wallet history, where lookalike addresses can be planted.</p><p>It does not stop every scam. A forged or phished pay link is still a risk, so always check the full address in your wallet before you sign.</p></div>
    </section>`;
  document.getElementById("create").addEventListener("click", create);
}

async function create(ev) {
  const b = ev.currentTarget;
  b.setAttribute("aria-busy", "true"); b.disabled = true;
  b.innerHTML = '<span class="spinner" aria-hidden="true"></span> Creating the draft…';
  try {
    const r = await api("/api/monthly", { method: "POST" });
    renderDraft(r, "waiting");
    poll(r);
  } catch (e) {
    b.removeAttribute("aria-busy"); b.disabled = false; b.textContent = "Create this month's payment";
    b.closest(".card").insertAdjacentHTML("beforeend", `<p class="error" role="alert">${esc(e.message)}</p>`);
  }
}

function renderDraft(r, state, paid) {
  const d = r.draft, c = r.checks;
  const amountAsset = (d.amountBaseUnits / 1e6).toFixed(2);
  const where = c.checks.map((x) => x.where === "draft.receiverAddress" ? "the draft" : x.where.startsWith("tx-template") ? "the wallet instructions" : "the QR link").join(", ").replace(/, ([^,]*)$/, " and $1");
  const banner = c.allMatch
    ? `<div class="banner ok" role="status"><span class="icon">${ICON.check}</span><div><strong>Address matches your approved payee</strong><p>All ${payee.address.length} characters match in ${where}.</p></div></div>`
    : `<div class="banner bad" role="alert"><span class="icon">${ICON.stop}</span><div><strong>Stop. The address does not match your approved payee.</strong><p>Do not pay this draft. Check your payee record first.</p></div></div>`;
  const heading = state === "paid" ? "Paid" : "Waiting for your signature";
  const lede = state === "paid"
    ? `${esc(payee.label)} has been paid for this month.`
    : "Open the payment in your own wallet, check the full address there, and sign.";
  app.innerHTML = `
    <section class="fade-in">
      <p class="eyebrow">Draft created · ${esc(d.memo)}</p>
      <h1>${heading}</h1>
      <p class="lede">${lede}</p>
      ${banner}
      ${stepper(state)}
      <article class="card">
        ${state === "paid" ? `
          <div class="banner ok" style="margin:0 0 18px"><span class="icon">${ICON.check}</span><div><strong>Paid${paid?.localTest ? '<span class="pill-local">Local test webhook</span>' : ""}</strong><p>${paid?.localTest ? "Shown from a locally signed test delivery, not a real payment." : "Confirmed on-chain."} ${paid?.confirmedAt ? "At " + esc(new Date(paid.confirmedAt).toLocaleString("en")) + "." : ""}</p></div></div>
          ${paid?.txId ? `<dl class="rows"><div class="row"><dt>Transaction</dt><dd class="mono">${esc(paid.txId)}</dd></div></dl>` : ""}` : `
          <div class="pay">
            ${r.qr ? `<div class="qr" role="img" aria-label="QR code for this payment">${r.qr}</div>` : ""}
            <div>
              <div class="amount">${esc(money(d.fiatAmount, d.fiatCurrency))}<small>${esc(amountAsset)} ${esc(d.currency.toUpperCase())} on ${esc(d.network)} · to ${esc(payee.label)}</small></div>
              <div class="actions" style="margin-top:20px"><a class="btn btn-primary" href="${esc(d.paymentUri)}">${ICON.wallet} Open in your wallet</a></div>
              <p class="fine" style="margin-top:12px">Or scan the QR code with your phone wallet.</p>
            </div>
          </div>`}
        <div class="addr-label"><h2 style="margin:0">Paying to</h2><span>${c.allMatch ? "Matches approved payee" : "Does not match"}</span></div>
        ${addrGrid(d.receiverAddress, "Receiving address in this draft")}
      </article>
      ${state !== "paid" ? `<div class="note" style="margin-top:20px">${ICON.eye}<div>Your wallet shows the full address before you sign. Compare it with the one above, group by group. If anything differs, stop.</div></div>` : ""}
      <dl class="rows" style="margin-top:24px"><div class="row"><dt>Draft</dt><dd class="mono">${esc(d.id)}</dd></div><div class="row"><dt>Expires</dt><dd>${esc(new Date(d.expiresAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }))}</dd></div></dl>
    </section>`;
  focusHeading();
}

function poll(r) {
  const tick = async () => {
    try {
      const s = await api(`/api/drafts/${r.draft.id}/status`);
      if (s.webhook) return renderDraft(r, "paid", s.webhook);
      if (s.status === "Confirmed") return renderDraft(r, "paid", { txId: s.paidTxId, confirmedAt: s.confirmedAt });
    } catch {}
    setTimeout(tick, 4000);
  };
  setTimeout(tick, 4000);
}

start();
