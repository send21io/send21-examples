import { randomBytes, randomUUID } from "node:crypto";

// Server-side send21 REST client. Only the endpoints this shop needs:
//   POST /api/v1/payment-requests      create a pay link (Idempotency-Key header)
//   GET  /api/v1/payment-requests/{id}  read its status (Open, Completed, Cancelled, Expired)
// Reference: https://send21.io/openapi.json and https://send21.io/docs/quickstart
//
// The API key is a scoped key (drafts:write; drafts:read for the status read).
// No send21 key can move funds, and this one never leaves the server.
export function createSend21Client({ apiBase = "https://send21.io", apiKey, fetchImpl = fetch }) {
  const base = apiBase.replace(/\/$/, "");
  async function call(path, { method = "GET", body, idempotencyKey } = {}) {
    const headers = { accept: "application/json", authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await fetchImpl(`${base}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // New send21 accounts only accept receiving addresses the owner approved (https://send21.io/docs/mcp).
      const notApproved = (JSON.stringify(json) ?? "").includes("address_not_approved");
      const hint = notApproved ? " (address_not_approved: approve this receiving address in send21, signed in with a passkey or authenticator code, then retry)" : "";
      const err = new Error(`send21 ${method} ${path}: ${res.status} ${JSON.stringify(json)?.slice(0, 300)}${hint}`);
      err.status = res.status;
      if (notApproved) err.code = "address_not_approved";
      throw err;
    }
    return json;
  }
  return {
    mode: "live",
    payBase: base,
    createPaymentRequest: (body, idempotencyKey) => call("/payment-requests", { method: "POST", body, idempotencyKey }),
    getPaymentRequest: (id) => call(`/payment-requests/${encodeURIComponent(id)}`),
  };
}

// DRY_RUN / mock mode: the same two calls answered locally, with the documented
// response fields (id, shareToken, payPath, orderId, fiatCurrency, fiatAmount,
// status, expiresAt, options). Nothing is sent to send21. The pay link points
// to a local mock pay page (/mock/pay/<token>) instead of https://send21.io/pay/...
export function createMockClient() {
  const byKey = new Map();
  const byId = new Map();
  const sameRequest = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    mode: "mock",
    payBase: "", // filled in by the server with its own origin
    requests: byId,
    async createPaymentRequest(body, idempotencyKey) {
      if (idempotencyKey && byKey.has(idempotencyKey)) {
        const prior = byKey.get(idempotencyKey);
        if (!sameRequest(prior.body, body)) {
          const err = new Error("mock send21: Idempotency-Key reused with a different request (422)");
          err.status = 422;
          throw err;
        }
        return prior.response;
      }
      if (body.reuseOpenForOrder && body.orderId) {
        // Documented: returns the open link for the same orderId that asks for
        // the same amount and addresses instead of creating a second one.
        for (const { body: b, response } of byId.values()) {
          if (response.status === "Open" && b.orderId === body.orderId && b.fiatAmount === body.fiatAmount &&
              b.fiatCurrency === body.fiatCurrency && sameRequest(b.options, body.options)) {
            if (idempotencyKey) byKey.set(idempotencyKey, { body, response });
            return response;
          }
        }
      }
      const now = Date.now();
      const token = randomBytes(12).toString("base64url");
      const response = {
        id: randomUUID(),
        shareToken: token,
        payPath: `/mock/pay/${token}`,
        orderId: body.orderId ?? null,
        fiatCurrency: body.fiatCurrency,
        fiatAmount: body.fiatAmount,
        memo: body.memo ?? null,
        status: "Open",
        expiresAt: new Date(now + (body.expiryHours ?? 24) * 3600_000).toISOString(),
        createdAt: new Date(now).toISOString(),
        options: body.options.map((o) => ({ ...o })),
        activeDraftId: null,
        draftStatus: null,
      };
      const entry = { body, response };
      byId.set(response.id, entry);
      if (idempotencyKey) byKey.set(idempotencyKey, entry);
      return response;
    },
    async getPaymentRequest(id) {
      const entry = byId.get(id);
      if (!entry) {
        const err = new Error("mock send21: not found (404)");
        err.status = 404;
        throw err;
      }
      return entry.response;
    },
  };
}
