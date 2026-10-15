const token = location.pathname.split("/")[3];
const $ = (id) => document.getElementById(id);
const info = await (await fetch(`/mock/pay/${token}/info`)).json();
$("amount").textContent = `${info.fiatAmount} ${info.fiatCurrency} for ${info.orderId}`;
$("asset").replaceChildren(...info.assets.map((a, i) => Object.assign(document.createElement("option"), { value: String(i), textContent: a.label })));
for (const b of document.querySelectorAll("button[data-outcome]")) {
  b.addEventListener("click", async () => {
    const res = await fetch(`/mock/pay/${token}/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome: b.dataset.outcome, asset: Number($("asset").value) }) });
    const r = await res.json();
    $("out").textContent = `Webhook answered ${r.webhookStatus}: outcome "${r.outcome ?? r.error}". Go back to the shop tab.`;
  });
}
