import { PAYMENT_TYPE_CRYPTO, invoiceCurrency } from "./invoiceninja.js";
import {
  buildPaymentRequest,
  createPaymentRequest,
  invoiceIdFromOrder,
  orderIdForInvoice,
  payLink,
  safeEqualString,
  verifySignatureV2,
} from "./send21.js";

const sameMoney = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);

/** Create (or get back) the pay link for an invoice and write it into the invoice's custom field. */
export async function createLinkForInvoice(invoiceId, deps) {
  const { api, store, config, fetchImpl = fetch } = deps;
  const invoice = await api.getInvoice(invoiceId);
  const currency = await invoiceCurrency(api, invoice, config.currency);
  const request = buildPaymentRequest(
    { invoiceId: invoice.id, number: invoice.number, balance: invoice.balance, currency },
    config.options,
    { declineNote: config.declineNote, expiryHours: config.expiryHours }
  );
  const pr = await createPaymentRequest(fetchImpl, config.send21ApiKey, request);
  const link = payLink(pr.payPath);
  store.saveLink(request.body.orderId, {
    invoiceId: invoice.id,
    clientId: invoice.client_id,
    amount: request.body.fiatAmount,
    currency,
    paymentRequestId: pr.id,
    link,
  });
  await api.setInvoiceField(invoice.id, config.linkField, link);
  return link;
}

/** Invoice Ninja webhook (create_invoice). Authenticated by a header you set on the webhook. */
export async function handleInvoiceNinjaWebhook({ headers, body }, deps) {
  if (!safeEqualString(headers["x-webhook-token"], deps.config.invoiceNinjaWebhookToken)) return { status: 401, body: "bad token" };
  const invoice = JSON.parse(body.toString("utf8"));
  const id = invoice?.id ?? invoice?.data?.id;
  if (!id) return { status: 400, body: "no invoice id" };
  const link = await createLinkForInvoice(id, deps);
  return { status: 200, body: JSON.stringify({ link }) };
}

/** send21 webhook. Verify first, skip handled deliveries, then record the payment in Invoice Ninja. */
export async function handleSend21Webhook({ headers, body }, deps) {
  const { api, store, config, now } = deps;
  const deliveryId = headers["x-send21-delivery"];
  if (!verifySignatureV2(body, headers["x-send21-signature-v2"], deliveryId, config.send21WebhookSecret, now)) {
    return { status: 401, body: "bad signature" };
  }
  // send21 retries reuse X-Send21-Delivery and send21 does not dedupe for you.
  if (store.hasDelivery(deliveryId)) return { status: 200, body: "already handled" };

  const { event, data = {} } = JSON.parse(body.toString("utf8"));
  const result = await applyEvent(event, data, deps);
  store.addDelivery(deliveryId); // after acting: a failed attempt is retried, not skipped
  return { status: 200, body: JSON.stringify(result) };
}

export async function applyEvent(event, data, { api, store }) {
  const invoiceId = invoiceIdFromOrder(data.orderId);
  if (!invoiceId) return { action: "ignore", note: "not an Invoice Ninja order" };
  const saved = store.getLink(orderIdForInvoice(invoiceId));
  if (!saved) return { action: "ignore", note: "unknown pay link" };
  if (data.paymentRequestId && saved.paymentRequestId && data.paymentRequestId !== saved.paymentRequestId) {
    return { action: "ignore", note: "another pay link for this invoice" };
  }

  if (event === "draft.confirmed") {
    if (saved.paidTxId) return { action: "ignore", note: "already recorded" };
    if (String(data.fiatCurrency).toUpperCase() !== saved.currency || !sameMoney(data.fiatAmount, saved.amount)) {
      return { action: "review", note: `confirmed ${data.fiatAmount} ${data.fiatCurrency}, link was for ${saved.amount} ${saved.currency}` };
    }
    const payment = await api.createPayment({
      client_id: saved.clientId,
      amount: saved.amount,
      date: String(data.confirmedAt ?? new Date().toISOString()).slice(0, 10),
      type_id: PAYMENT_TYPE_CRYPTO,
      transaction_reference: String(data.txId ?? ""),
      private_notes: [
        `send21 draft ${data.draftId}`,
        `${data.sentAmount} ${data.sentCurrency} on ${data.network}`,
        data.conversionRate ? `rate ${data.conversionRate} (${data.rateSource ?? "send21"}), quote ${data.quoteId ?? "-"}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      invoices: [{ invoice_id: saved.invoiceId, amount: saved.amount }],
    });
    store.saveLink(orderIdForInvoice(invoiceId), { paidTxId: data.txId, paymentId: payment?.id ?? null });
    return { action: "paid", paymentId: payment?.id ?? null };
  }
  if (["draft.amount_mismatch", "draft.mismatch_reminder", "draft.mismatch_unresolved"].includes(event)) {
    return { action: "review", note: `${event}: accept or decline the transfer in send21; refunds are manual` };
  }
  if (event === "payment_request.expired") {
    store.saveLink(orderIdForInvoice(invoiceId), { expired: true, opened: Boolean(data.opened) });
    return { action: "expired", note: "invoice stays open; run create-link again for a new link" };
  }
  return { action: "ignore", note: `event ${event} not used` };
}
