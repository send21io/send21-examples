// Demo shop frontend. The cart is client-side; the order and its total are
// created by the backend (POST /orders), then <send21-checkout> takes over.
const $ = (id) => document.getElementById(id);
const cart = new Map();
let catalog = { currency: "EUR", products: [] };

const money = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: catalog.currency }).format(n);

function renderCart() {
  const lines = [...cart.entries()].filter(([, q]) => q > 0);
  $("cart-lines").replaceChildren(...lines.map(([sku, qty]) => {
    const p = catalog.products.find((x) => x.sku === sku);
    const li = document.createElement("li");
    li.textContent = `${qty} × ${p.name} — ${money(p.price * qty)}`;
    return li;
  }));
  const total = lines.reduce((s, [sku, q]) => s + catalog.products.find((x) => x.sku === sku).price * q, 0);
  $("cart-total").textContent = money(total);
  $("pay").disabled = lines.length === 0;
}

async function init() {
  catalog = await (await fetch("/products")).json();
  if (catalog.mode === "mock") {
    $("mode").hidden = false;
    $("mode").textContent = "DRY_RUN: mock send21, no real payment";
  }
  $("products").replaceChildren(...catalog.products.map((p) => {
    const li = document.createElement("li");
    li.className = "product";
    const name = document.createElement("span");
    name.textContent = `${p.name} · ${money(p.price)}`;
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add to cart";
    add.setAttribute("aria-label", `Add ${p.name} to cart`);
    add.addEventListener("click", () => { cart.set(p.sku, (cart.get(p.sku) ?? 0) + 1); renderCart(); });
    li.append(name, add);
    return li;
  }));
  // Start with something in the cart so the demo is one click away.
  cart.set(catalog.products[0].sku, 2);
  cart.set(catalog.products[2].sku, 1);
  renderCart();
}

$("pay").addEventListener("click", async () => {
  $("pay").disabled = true;
  const items = [...cart.entries()].filter(([, q]) => q > 0).map(([sku, qty]) => ({ sku, qty }));
  const res = await fetch("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
  const order = await res.json();
  if (!res.ok) { $("result").textContent = order.error; $("pay").disabled = false; return; }
  const el = document.createElement("send21-checkout");
  el.setAttribute("order-id", order.orderId);
  el.setAttribute("amount", String(order.fiatAmount));
  el.setAttribute("currency", order.fiatCurrency);
  el.addEventListener("send21:paid", (e) => { $("result").textContent = `Order ${e.detail.orderId} is paid (tx ${e.detail.txId}). We'll ship it now.`; });
  el.addEventListener("send21:expired", () => { $("result").textContent = "The pay link expired. Press “Try again” for a new one."; });
  el.addEventListener("send21:error", (e) => { $("result").textContent = e.detail.message; });
  $("checkout").replaceChildren(el);
});

init();
