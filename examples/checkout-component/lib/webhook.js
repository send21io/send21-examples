// What the shop does with a verified send21 delivery.
//
// send21 protects its side (exact-amount matching, a second-source lookup
// before confirming, rate locks). The shop still checks every draft.confirmed
// against its own order before it ships anything, as the webhook docs ask:
// "Before you ship goods, check that the amount, currency and orderId are the
// ones you expect." https://send21.io/docs/webhooks

const cents = (n) => Math.round(Number(n) * 100);
const eq = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Compare a draft.confirmed payload with the stored order.
 * @returns {string[]} problems; empty when the payment matches the order
 */
export function checkConfirmedAgainstOrder(data, order) {
  const problems = [];
  if (data.orderId !== order.orderId) problems.push(`orderId ${data.orderId} != ${order.orderId}`);
  if (data.status !== undefined && data.status !== "Confirmed") problems.push(`status is ${data.status}, not Confirmed`);
  if (!data.txId) problems.push("no txId");
  if (!order.paymentRequestIds?.includes(data.paymentRequestId)) problems.push(`pay link ${data.paymentRequestId} was not created for this order`);
  if (!eq(data.fiatCurrency, order.fiatCurrency)) problems.push(`currency ${data.fiatCurrency} != ${order.fiatCurrency}`);
  if (!Number.isFinite(Number(data.fiatAmount)) || cents(data.fiatAmount) !== cents(order.fiatAmount)) {
    problems.push(`amount ${data.fiatAmount} != ${order.fiatAmount}`);
  }
  // sentCurrency is upper case in payloads ("USDC"), options use API enums ("Usdc").
  const offered = order.options.some((o) => eq(o.currency, data.sentCurrency) && eq(o.network, data.network));
  if (!offered) problems.push(`asset ${data.sentCurrency} on ${data.network} was not offered for this order`);
  return problems;
}

/**
 * Apply one verified event to the store.
 * @param {{ event: string, data?: object }} body parsed delivery body
 * @param {ReturnType<import("./store.js").createStore>} store
 * @param {{ log?: (line: string) => void, acceptDifferentAmount?: boolean }} [options]
 * @returns {string} outcome
 */
export function applyEvent(body, store, { log = console.log, acceptDifferentAmount = false } = {}) {
  const data = body?.data ?? {};
  // Find the order by our own orderId. Only when a payload carries no orderId
  // (it is documented for pay-link payments) fall back to the pay link id.
  const order = (data.orderId ? store.getOrder(data.orderId)
    : data.paymentRequestId && store.findOrderByPaymentRequest(data.paymentRequestId)) || null;
  const save = (patch) => store.putOrder({ ...order, ...patch, updatedAt: new Date().toISOString() });

  switch (body?.event) {
    case "test":
      return "test";

    case "draft.confirmed": {
      if (!order) { log(`draft.confirmed for unknown order ${data.orderId}: ignored`); return "unknown_order"; }
      if (order.status === "paid") return "already_paid";
      const problems = checkConfirmedAgainstOrder(data, order);
      if (problems.length > 0) {
        log(`order ${order.orderId}: confirmed payment does NOT match the order (${problems.join("; ")}); not marking paid`);
        save({ alerts: [...(order.alerts ?? []), { at: new Date().toISOString(), draftId: data.draftId, txId: data.txId, problems }] });
        return "mismatch";
      }
      // Set only when what arrived differs from the billed amount and the
      // receiver accepted it on send21 (by hand or by shortfallPolicy).
      const different = data.receivedAmountSats !== undefined && data.receivedAmountSats !== data.amountSats;
      if (different && !acceptDifferentAmount) {
        log(`order ${order.orderId}: different amount accepted on send21 (received ${data.receivedAmount}, billed ${data.sentAmount} ${data.sentCurrency}); held for review`);
        save({ status: "review", txId: data.txId, review: "different_amount" });
        return "review";
      }
      save({
        status: "paid",
        txId: data.txId,
        paidAt: data.occurredAt ?? new Date().toISOString(),
        paidWith: { currency: data.sentCurrency, network: data.network, amount: data.receivedAmount ?? data.sentAmount, draftId: data.draftId },
      });
      log(`order ${order.orderId}: paid, ${data.receivedAmount ?? data.sentAmount} ${data.sentCurrency} on ${data.network}, tx ${data.txId}`);
      return "order_paid";
    }

    case "draft.seen":
      if (order && order.status === "awaiting_payment") { save({ status: "seen" }); return "seen"; }
      return "ignored";

    case "draft.amount_mismatch":
      // Waits for the receiver's decision on send21; never paid on its own.
      if (order && order.status !== "paid") { save({ status: "review", review: "amount_mismatch_pending" }); return "review"; }
      return "ignored";

    case "payment_request.expired":
      if (order && order.status !== "paid" && order.paymentRequestId === (data.paymentRequestId ?? order.paymentRequestId)) {
        save({ status: "expired" });
        return "expired";
      }
      return "ignored";

    default:
      return "ignored";
  }
}
