// Tiny React wrapper for <send21-checkout>. No JSX, so it works with or without a build step.
//
//   import { Send21Checkout } from "./react/Send21Checkout.js";
//   <Send21Checkout orderId={order.id} amount={order.total} currency="EUR"
//     onPaid={(e) => showThanks(e.detail.txId)} onExpired={() => offerRetry()} />
import { createElement, useEffect, useRef } from "react";
import "../send21-checkout.js";

const EVENTS = { onReady: "send21:ready", onStatus: "send21:status", onPaid: "send21:paid", onExpired: "send21:expired", onError: "send21:error" };

export function Send21Checkout({ orderId, amount, currency, endpoint, pollInterval, locale, ...rest }) {
  const ref = useRef(null);
  const handlers = useRef({});
  for (const key of Object.keys(EVENTS)) handlers.current[key] = rest[key];
  const props = Object.fromEntries(Object.entries(rest).filter(([k]) => !(k in EVENTS)));

  useEffect(() => {
    const el = ref.current;
    const listeners = Object.entries(EVENTS).map(([key, type]) => {
      const fn = (e) => handlers.current[key]?.(e);
      el.addEventListener(type, fn);
      return [type, fn];
    });
    return () => listeners.forEach(([type, fn]) => el.removeEventListener(type, fn));
  }, []);

  return createElement("send21-checkout", {
    ref,
    "order-id": orderId,
    amount: amount === undefined ? undefined : String(amount),
    currency,
    endpoint,
    "poll-interval": pollInterval === undefined ? undefined : String(pollInterval),
    locale,
    ...props,
  });
}

export default Send21Checkout;
