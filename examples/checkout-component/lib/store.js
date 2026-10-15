import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// A tiny key-value store: in memory, optionally mirrored to a JSON file.
// Fine for a demo with one process. Use your shop's real database in production
// (orders and seen webhook delivery ids must survive restarts and be shared
// between instances).
export function createStore(file) {
  let data = { orders: {}, deliveries: {} };
  if (file) {
    try { data = { ...data, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { /* first start */ }
  }
  const save = () => {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${file}.tmp`, file);
  };
  return {
    getOrder: (id) => data.orders[id],
    putOrder: (order) => { data.orders[order.orderId] = order; save(); return order; },
    findOrderByPaymentRequest: (id) => Object.values(data.orders).find((o) => o.paymentRequestId === id),
    hasDelivery: (id) => Object.hasOwn(data.deliveries, id),
    addDelivery: (id, outcome) => { data.deliveries[id] = { outcome, at: new Date().toISOString() }; save(); },
  };
}
