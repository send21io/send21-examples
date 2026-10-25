const app = document.getElementById("app");
const ICON = {
  check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  small: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>',
  eye: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  ext: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  wallet: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2"/><path d="M3 9h18"/></svg>',
  camera: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n, cur) => new Intl.NumberFormat("en", { style: "currency", currency: cur }).format(n);
const addrGrid = (chunks, label) => `<div class="addr" role="group" aria-label="${esc(label)}: ${esc(chunks.join(" "))}">${chunks.map((c) => `<span>${esc(c)}</span>`).join("")}</div>`;
const chunk = (a) => String(a).match(/.{1,4}/g) ?? [];

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body.error || `HTTP ${r.status}`); e.body = body; throw e; }
  return body;
}
const focusHeading = () => { const h = app.querySelector("h1"); h?.setAttribute("tabindex", "-1"); h?.focus({ preventScroll: true }); };

function stepper(at) {
  const steps = [["Draft created", "By your agent"], ["Waiting for your signature", "In your own wallet"], ["Paid", "Confirmed on-chain"]];
  return `<ol class="stepper" aria-label="Payment progress">${steps.map(([t, s], i) => `<li class="step ${i < at ? "done" : i === at ? "active" : ""}" ${i === at ? 'aria-current="step"' : ""}><b>${t}</b><small>${s}</small></li>`).join("")}</ol>`;
}

let v;
// Honest wording: "pre-approved" only for an owner-verified send21 address book entry.
const approved = () => Boolean(v?.helper?.approvedInSend21);
async function start() {
  try { v = await api("/api/task"); render(); if (v.phase === "awaiting_signature") poll(); }
  catch (e) { app.innerHTML = `<h1>Something is not set up yet</h1><p class="error">${esc(e.message)}</p>`; }
}
function render() { v.phase === "in_progress" ? renderTask() : renderReview(); }

function renderTask() {
  const { task, helper } = v;
  app.innerHTML = `
    <section class="fade-in">
      <p class="eyebrow">Your agent · helper task</p>
      <h1>A helper you trust is on it</h1>
      <p class="lede">Your agent asked your local helper for a quick check. When the task is done, the agent drafts the payment and you sign it in your own wallet.</p>
      <article class="card" aria-labelledby="task-title">
        <div class="card-head" style="margin-bottom:18px">
          <div class="avatar" aria-hidden="true">${ICON.camera}</div>
          <div><div class="meta">Task</div><h2 class="task-title" id="task-title" style="color:var(--ink)">${esc(task.title)}</h2></div>
          <div class="chips"><span class="status-chip">In progress</span></div>
        </div>
        <p class="task-details">${esc(task.details)}</p>
        <dl class="rows">
          <div class="row"><dt>Where</dt><dd>${esc(task.where)}</dd></div>
          <div class="row"><dt>Helper</dt><dd>${esc(helper.label)}</dd></div>
          <div class="row"><dt>Agreed amount</dt><dd>${esc(money(task.fiatAmount, task.fiatCurrency))} · ${esc(helper.currency.toUpperCase())} on ${esc(helper.network)}</dd></div>
        </dl>
        <div class="addr-label"><h2 style="margin:0">Helper's receiving address</h2><span>${approved() ? "Pre-approved in send21" : "Saved by you"}</span></div>
        ${addrGrid(helper.chunks, approved() ? "Helper's pre-approved receiving address" : "Helper's saved receiving address")}
        <p class="source">${ICON.shield}<span>${approved() ? "Approved by you in your send21 address book. Your agent cannot change it." : `Saved once from what your helper gave you (${esc(helper.source)}), not in your send21 address book. Your agent cannot change it.`}</span></p>
        <div class="actions">
          <button class="btn btn-primary" id="done">Task done</button>
          <p class="fine">Your agent drafts the payment. Nothing moves until you sign.</p>
        </div>
      </article>
    </section>`;
  document.getElementById("done").addEventListener("click", done);
}

async function done(ev) {
  const card = ev.currentTarget.closest(".card");
  app.innerHTML = `
    <section class="fade-in">
      <p class="eyebrow">Task done</p>
      <h1>Your agent is drafting the payment</h1>
      <p class="lede">It asks send21 for a payment draft to ${approved() ? "your helper's pre-approved address" : "the helper address you saved"}. It cannot sign or pay.</p>
      <div class="card"><div class="working"><span class="spinner" aria-hidden="true"></span><span>Checking the address rules and creating the draft…</span></div></div>
    </section>`;
  focusHeading();
  const started = Date.now();
  try {
    const r = await api("/api/task/done", { method: "POST" });
    await new Promise((ok) => setTimeout(ok, Math.max(0, 900 - (Date.now() - started)))); // let the step register
    v = r; render(); poll();
  } catch (e) {
    app.innerHTML = `<section class="fade-in"><p class="eyebrow">Task done</p><h1>Your agent stopped</h1><p class="lede">${esc(e.message)}</p>${agentLog(e.body?.steps ?? [])}<div class="actions"><button class="btn btn-quiet" onclick="location.reload()">Back to the task</button></div></section>`;
    focusHeading();
  }
}

function agentLog(steps, reused) {
  const words = {
    get_account_status: "Checked your account's address rules",
    list_address_book: "Looked up the helper's address in your send21 address book",
    "POST /drafts": "Created the payment draft with an <code>Idempotency-Key</code> from the task id",
    "POST /drafts/{id}/requote": "Renewed the 15-minute price lock",
  };
  return `<ol class="agent-log">${steps.map((s) => `<li><span class="dot">${ICON.small}</span><span><b style="color:var(--ink)">${words[s.tool] ?? s.tool}</b><br><code>${esc(s.tool)}</code> ${esc(s.result)}</span></li>`).join("")}${reused ? `<li><span class="dot">${ICON.small}</span><span><b style="color:var(--ink)">Asked again, got the same draft</b><br>The same Idempotency-Key returns this draft instead of a second one.</span></li>` : ""}</ol>`;
}

function renderReview() {
  const { task, helper, review, phase, paid } = v;
  const d = review.draft;
  const isPaid = phase === "paid";
  const match = review.addressCheck.match;
  const assetAmount = (d.amountBaseUnits / 1e6).toFixed(2);
  app.innerHTML = `
    <section class="fade-in">
      <p class="eyebrow">${isPaid ? "Done" : "Owner review"} · ${esc(task.title)}</p>
      <h1>${isPaid ? "Paid" : "Review and sign"}</h1>
      <p class="lede">${isPaid ? `${esc(helper.label)} has been paid for the task.` : "Your agent drafted this payment. Check it, then open it in your own wallet and sign."}</p>
      ${match
        ? `<div class="banner ok" role="status"><span class="icon">${ICON.check}</span><div><strong>${approved() ? "Pays your helper's pre-approved address" : "Matches the helper address you saved"}</strong><p>All ${helper.address.length} characters match ${approved() ? "the address you approved in send21" : "the address you saved"}.</p></div></div>`
        : `<div class="banner bad" role="alert"><span class="icon">${ICON.stop}</span><div><strong>Stop. This draft does not pay your helper's address.</strong><p>Do not sign. Check the helper record first.</p></div></div>`}
      ${stepper(isPaid ? 3 : 1)}
      <article class="card">
        ${isPaid ? `<div class="banner ok" style="margin:0 0 18px"><span class="icon">${ICON.check}</span><div><strong>Paid${paid?.localTest ? '<span class="pill-local">Local test webhook</span>' : ""}</strong><p>${paid?.localTest ? "Shown from a locally signed test delivery, not a real payment." : "Confirmed on-chain."}${paid?.confirmedAt ? " At " + esc(new Date(paid.confirmedAt).toLocaleString("en")) + "." : ""}</p></div></div>` : ""}
        <div class="${isPaid ? "" : "pay"}">
          ${!isPaid && review.qr ? `<div class="qr" role="img" aria-label="QR code for this payment">${review.qr}</div>` : ""}
          <div>
            <div class="meta">Pay ${esc(helper.label.toLowerCase())}</div>
            <div class="amount">${esc(money(d.fiatAmount, d.fiatCurrency))}<small>${esc(assetAmount)} ${esc(d.currency.toUpperCase())} on ${esc(d.network)} · ${esc(task.title)}</small></div>
            ${isPaid ? "" : `<div class="actions" style="margin-top:20px"><a class="btn btn-primary" href="${esc(d.paymentUri)}">${ICON.wallet} Open the payment to sign in your wallet</a></div>
            <p class="fine" style="margin-top:12px">Or scan the QR code with your phone wallet. send21 never signs.</p>`}
          </div>
        </div>
        <div class="addr-label"><h2 style="margin:0">Pays to</h2><span>${match ? (approved() ? "Matches pre-approved address" : "Matches your saved address") : "Does not match"}</span></div>
        ${addrGrid(chunk(d.receiverAddress), "Address in this draft")}
        ${isPaid && paid?.txId ? `<dl class="rows" style="margin-top:18px"><div class="row"><dt>Transaction</dt><dd class="mono">${esc(paid.txId)}</dd></div></dl>` : ""}
      </article>
      ${isPaid ? "" : `<div class="note" style="margin-top:20px">${ICON.eye}<div>Your wallet shows the full address before you sign. Compare it with the one above. If anything differs, stop.</div></div>`}
      <details class="how" ${isPaid ? "" : "open"}><summary>What your agent did</summary>${agentLog(review.steps, review.reused)}</details>
      <dl class="rows" style="margin-top:24px">
        <div class="row"><dt>Draft</dt><dd class="mono">${esc(d.id)}</dd></div>
        <div class="row"><dt>Idempotency-Key</dt><dd class="mono">${esc(v.idempotencyKey)}</dd></div>
        ${!isPaid && d.lockedUntil ? `<div class="row"><dt>Price locked until</dt><dd>${esc(new Date(d.lockedUntil).toLocaleTimeString("en", { timeStyle: "short" }))}</dd></div>` : ""}
        <div class="row"><dt>Expires</dt><dd>${esc(new Date(d.expiresAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }))}</dd></div>
      </dl>
      <div class="limits"><p>send21 drafts the payment and you sign it, nothing more. There is no escrow, no dispute handling and no check of the work itself: pay helpers you know and trust.</p></div>
    </section>`;
  focusHeading();
}

let timer;
function poll() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try { const n = await api("/api/task/status"); const changed = n.phase !== v.phase; v = n; if (changed) return render(); } catch {}
    poll();
  }, 4000);
}
start();
