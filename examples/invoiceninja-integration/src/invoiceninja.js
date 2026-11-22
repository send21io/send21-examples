// Small Invoice Ninja v5 REST client (https://api-docs.invoicing.co/). Auth: X-API-TOKEN.
export const PAYMENT_TYPE_CRYPTO = "31"; // Invoice Ninja payment type "Crypto"

export function invoiceNinjaClient({ baseUrl, token, fetchImpl = fetch }) {
  const root = String(baseUrl).replace(/\/+$/, "");
  async function call(method, path, body) {
    const res = await fetchImpl(`${root}/api/v1${path}`, {
      method,
      headers: {
        "X-API-TOKEN": token,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Invoice Ninja API ${method} ${path}: ${res.status}`);
    const json = await res.json();
    return json.data ?? json;
  }
  return {
    getInvoice: (id) => call("GET", `/invoices/${encodeURIComponent(id)}`),
    getClient: (id) => call("GET", `/clients/${encodeURIComponent(id)}`),
    getStatics: () => call("GET", "/statics"),
    setInvoiceField: (id, field, value) => call("PUT", `/invoices/${encodeURIComponent(id)}`, { [field]: value }),
    createPayment: (payment) => call("POST", "/payments", payment),
  };
}

/** Currency code for an invoice: explicit override, or the client's currency via /statics. */
export async function invoiceCurrency(api, invoice, override) {
  if (override) return String(override).toUpperCase();
  const client = await api.getClient(invoice.client_id);
  const currencyId = String(client?.settings?.currency_id ?? "");
  const statics = await api.getStatics();
  const currency = (statics.currencies ?? []).find((c) => String(c.id) === currencyId);
  if (!currency?.code) throw new Error("could not find the client's currency; set INVOICENINJA_CURRENCY");
  return currency.code.toUpperCase();
}
