// Talks to the Node backend. The device token lives in localStorage, one per
// "slot" so two users can share one browser for testing (?as=anna, ?as=bo).
//
// Failures come back as Errors with a short, human message and a `code`:
// offline, rate_limited (with retryAfter seconds), server, or the server's own message.

export function serverApi(slot, { storagePrefix = "pair" } = {}) {
  const KEY = `${storagePrefix}.token.${slot}`;
  let cfg = null;
  const tokenOf = () => localStorage.getItem(KEY);
  const inflight = new Map(); // one identical write at a time (double taps, impatient retries)

  async function send(method, path, body) {
    const headers = { Accept: "application/json" };
    const t = tokenOf();
    if (t) headers.Authorization = `Bearer ${t}`;
    if (body) headers["Content-Type"] = "application/json";
    let res;
    try {
      res = await fetch(path.replace(/^\//, ""), { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw Object.assign(new Error("You're offline. Try again when you're back."), { code: "offline", status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfter = Math.max(1, Math.min(600, Number(res.headers.get("Retry-After")) || 10));
        throw Object.assign(new Error(`Too many tries. Wait ${retryAfter} s and try again.`), { code: "rate_limited", status: 429, retryAfter });
      }
      const msg = res.status >= 500 ? (res.status === 502 && data.error ? data.error : "Something went wrong on our side. Try again.") : (data.error ?? `Error ${res.status}`);
      throw Object.assign(new Error(msg), { code: res.status >= 500 ? "server" : "request", status: res.status });
    }
    return data;
  }
  function call(method, path, body) {
    if (method === "GET") return send(method, path, body);
    const k = `${method} ${path} ${body ? JSON.stringify(body) : ""}`;
    if (inflight.has(k)) return inflight.get(k);
    const p = send(method, path, body).finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }

  function stream(path, onData) {
    const es = new EventSource(path.replace(/^\//, ""));
    es.onmessage = (e) => { try { onData(JSON.parse(e.data)); } catch { /* ignore */ } };
    return () => es.close();
  }

  return {
    kind: "server",
    async config() { return (cfg ??= await call("GET", "/api/config")); },
    hasUser: () => !!tokenOf(),
    async signup({ name, fiat }) {
      const r = await call("POST", "/api/users", { name, fiat });
      localStorage.setItem(KEY, r.token);
      return r.user;
    },
    forget() { localStorage.removeItem(KEY); },
    me: () => call("GET", "/api/me"),
    updateMe: (b) => call("PUT", "/api/me", b),
    resetPairCode: () => call("POST", "/api/me/pair-code"),
    pairInfo: (code) => call("GET", `/api/pair/${encodeURIComponent(code)}`),
    addContact: (code) => call("POST", "/api/contacts", { code }),
    removeContact: (id) => call("DELETE", `/api/contacts/${encodeURIComponent(id)}`),
    async createRequests(b) { return (await call("POST", "/api/requests", b)).requests; },
    payInfo: (id, k) => call("GET", `/api/pay/${encodeURIComponent(id)}?k=${encodeURIComponent(k)}`),
    simulate: (id, k, outcome = "ok") => call("POST", `/api/pay/${encodeURIComponent(id)}/simulate?k=${encodeURIComponent(k)}&outcome=${encodeURIComponent(outcome)}`),
    cancel: (id) => call("POST", `/api/requests/${encodeURIComponent(id)}/cancel`),
    remind: (id) => call("POST", `/api/requests/${encodeURIComponent(id)}/remind`),
    subscribePay: (id, k, cb) => stream(`/api/pay/${encodeURIComponent(id)}/events?k=${encodeURIComponent(k)}`, (m) => m.request && cb(m.request)),
    subscribeMe: (cb) => (tokenOf() ? stream(`/api/events?t=${encodeURIComponent(tokenOf())}`, cb) : () => {}),
    savePush: (subscription) => call("POST", "/api/push", { subscription }),
    testPush: () => call("POST", "/api/push/test"),
    pairUrl: (me) => me.user.pair_url,
    payUrl: (r) => new URL(r.pay_path.replace(/^\//, ""), location.href.split("#")[0]).href,
  };
}
