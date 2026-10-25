// Tiny REST client for the send21 API (https://send21.io/api/v1).
// The key is read from SEND21_API_KEY and stays on the server. A scoped key
// can create and read drafts; no key can move funds.
export class Send21Error extends Error {
  constructor(status, body) {
    super(`send21 ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export function client({ apiKey = process.env.SEND21_API_KEY, baseUrl = process.env.SEND21_BASE_URL || "https://send21.io", fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("SEND21_API_KEY is not set. Copy .env.example to .env and add a scoped key.");
  async function call(method, path, body, { idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await fetchImpl(`${baseUrl}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new Send21Error(res.status, data);
    return data;
  }
  return {
    baseUrl,
    get: (p) => call("GET", p),
    post: (p, b, o) => call("POST", p, b ?? {}, o),
  };
}
