import { randomUUID } from "node:crypto";
import { ASSETS, mockBaseUnits, networkOf, paymentUri } from "../web/lib/core.js";

// Three ways to get a payment draft. Only documented send21 endpoints and
// fields are used (https://send21.io/openapi.json):
//
//   mock  no network, no key. Drafts are simulated with the receiver's own
//         testnet address; links have the same format send21 returns.
//   demo  POST /api/v1/demo/drafts and GET /api/v1/demo/drafts/{id}: the public
//         testnet demo, no key. send21 picks a small fixed amount and its own
//         demo receive wallet (the request body is only network + currency).
//   api   POST /api/v1/drafts with a scoped key (drafts:write) to the receiver's
//         own address, and POST /api/v1/payment-requests for an open pay link.
//         send21 accounts use LIVE networks, so this mode is gated by
//         PAIR_ALLOW_LIVE=1.

export const SEND21_BASE = "https://send21.io";

export class Send21Error extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(fetchImpl, method, url, { key, body, idempotencyKey } = {}) {
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (key) headers.Authorization = `Bearer ${key}`;
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetchImpl(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Send21Error(json?.error ?? json?.title ?? `send21 answered ${res.status}`, res.status, json ?? text);
  return json;
}

export function mockProvider() {
  return {
    mode: "mock",
    async createDraft({ assetId, receiverAddress, fiat, fiatAmount, memo }) {
      const net = networkOf(assetId, "mock");
      const baseUnits = mockBaseUnits(fiatAmount, fiat, assetId);
      return {
        draftId: randomUUID(),
        network: net.network,
        currency: ASSETS[assetId].currency,
        receiverAddress,
        amountBaseUnits: baseUnits,
        paymentUri: paymentUri({ assetId, address: receiverAddress, baseUnits, mode: "mock", message: memo }),
        payUrl: null,
        expiresAt: Date.now() + 72 * 3600_000,
      };
    },
  };
}

export function demoProvider({ fetch: fetchImpl = globalThis.fetch, base = SEND21_BASE } = {}) {
  return {
    mode: "demo",
    async createDraft({ assetId }) {
      const net = networkOf(assetId, "demo");
      // CreateDemoDraftRequest has only network and currency.
      const d = await call(fetchImpl, "POST", `${base}/api/v1/demo/drafts`, {
        body: { network: net.network, currency: ASSETS[assetId].currency },
      });
      return {
        draftId: d.id,
        network: d.network,
        currency: d.currency,
        receiverAddress: d.receiverAddress, // send21's demo wallet, not the user's
        amountBaseUnits: d.amountBaseUnits,
        paymentUri: d.paymentUri,
        payUrl: null,
        expiresAt: Date.parse(d.expiresAt),
      };
    },
    /** DemoDraftResponse: status AwaitingPayment | Seen | Confirmed | Expired | Cancelled, paidTxId. */
    async getDraft(id) {
      return call(fetchImpl, "GET", `${base}/api/v1/demo/drafts/${encodeURIComponent(id)}`);
    },
  };
}

export function apiProvider({ key, fetch: fetchImpl = globalThis.fetch, base = SEND21_BASE } = {}) {
  if (!key) throw new Error("SEND21_API_KEY is required in api mode");
  return {
    mode: "api",
    /**
     * One payment to the receiver's own address, priced in fiat by send21.
     * CreateDraftRequest has no orderId, so the request id travels in the
     * Idempotency-Key and the memo, and webhooks are matched on draftId.
     */
    async createDraft({ assetId, receiverAddress, fiat, fiatAmount, memo, idempotencyKey }) {
      const a = ASSETS[assetId];
      const net = networkOf(assetId, "api");
      const body = {
        receiverAddress,
        network: net.network,
        currency: a.currency,
        paymentMethod: a.method ?? "MultiOutput",
        singleOutput: true, // one QR payment from any wallet; the fee accrues to the account
        fiatCurrency: fiat,
        fiatAmount,
        memo,
        expiryHours: 72,
      };
      const d = await call(fetchImpl, "POST", `${base}/api/v1/drafts`, { key, body, idempotencyKey });
      const returned = d.receiverAddress ?? d.lightningAddress;
      if (returned && returned !== receiverAddress) {
        // Never show a payer a draft to an address the receiver did not set.
        throw new Send21Error("send21 returned a different receiver address", 502, d);
      }
      return {
        draftId: d.id,
        network: d.network,
        currency: d.currency,
        receiverAddress,
        amountBaseUnits: d.amountBaseUnits ?? d.amountSats,
        paymentUri: d.paymentUri,
        payUrl: null,
        expiresAt: Date.parse(d.expiresAt),
      };
    },
    /**
     * An open pay link anyone can pay: the payer picks one of the receiver's
     * assets on send21's pay page. orderId = our request id; reuseOpenForOrder
     * returns the open link instead of a second one.
     */
    async createPayLink({ options, fiat, fiatAmount, memo, orderId, idempotencyKey }) {
      const body = {
        fiatCurrency: fiat,
        fiatAmount,
        orderId,
        memo,
        expiryHours: 72,
        reuseOpenForOrder: true,
        options: options.map(({ assetId, address }) => {
          const a = ASSETS[assetId];
          const o = { currency: a.currency, network: networkOf(assetId, "api").network, address };
          if (a.method) o.method = a.method;
          return o;
        }),
      };
      const pr = await call(fetchImpl, "POST", `${base}/api/v1/payment-requests`, { key, body, idempotencyKey });
      for (const o of pr.options ?? []) {
        if (!options.some((x) => x.address === o.address)) throw new Send21Error("send21 returned an unexpected address", 502, pr);
      }
      return { paymentRequestId: pr.id, payUrl: `${base}${pr.payPath}`, expiresAt: Date.parse(pr.expiresAt) };
    },
  };
}

export function makeProvider(config, fetchImpl) {
  if (config.mode === "demo") return demoProvider({ fetch: fetchImpl });
  if (config.mode === "api") return apiProvider({ key: config.apiKey, fetch: fetchImpl });
  return mockProvider();
}
