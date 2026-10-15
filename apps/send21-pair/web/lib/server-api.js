// Talks to the Node backend. The device token lives in localStorage, one per
// "slot" so two users can share one browser for testing (?as=anna, ?as=bo).

export function serverApi(slot) {
  const KEY = `pair.token.${slot}`;
  let cfg = null;
  const tokenOf = () => localStorage.getItem(KEY);

  async function call(method, path, body) {
    const headers = { Accept: "application/json" };
    const t = tokenOf();
    if (t) headers.Authorization = `Bearer ${t}`;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(path.replace(/^\//, ""), { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error ?? `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
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
    removeContact: (id) => call("DELETE", `/api/contacts/${id}`),
    async createRequests(b) { return (await call("POST", "/api/requests", b)).requests; },
    payInfo: (id, k) => call("GET", `/api/pay/${id}?k=${encodeURIComponent(k)}`),
    simulate: (id, k, outcome = "ok") => call("POST", `/api/pay/${id}/simulate?k=${encodeURIComponent(k)}&outcome=${outcome}`),
    cancel: (id) => call("POST", `/api/requests/${id}/cancel`),
    remind: (id) => call("POST", `/api/requests/${id}/remind`),
    subscribePay: (id, k, cb) => stream(`/api/pay/${id}/events?k=${encodeURIComponent(k)}`, (m) => m.request && cb(m.request)),
    subscribeMe: (cb) => (tokenOf() ? stream(`/api/events?t=${encodeURIComponent(tokenOf())}`, cb) : () => {}),
    savePush: (subscription) => call("POST", "/api/push", { subscription }),
    testPush: () => call("POST", "/api/push/test"),
    pairUrl: (me) => me.user.pair_url,
    payUrl: (r) => new URL(r.pay_path.replace(/^\//, ""), location.href.split("#")[0]).href,
  };
}
