// Client-side mock backend for the static demo (GitHub Pages). There is no
// server: data stays in this browser (localStorage) and the links and QR codes
// carry what the other phone needs (a contact card, a request, a receipt).
// No send21 call, no key, no real money: TESTNET mock only.

import {
  ASSETS, DEMO_ADDRESSES, FIATS, assetsFor, avatarColor, cryptoLine, decodeCard, encodeCard, mockBaseUnits, networkOf, paymentUri, pickAsset, randomId, splitAmount, statusText, canMove,
} from "./core.js";

const uuid = () => randomId();
const base = () => location.href.split("#")[0].split("?")[0];

export function staticApi(slot) {
  const KEY = `pair.static.${slot}`;
  const load = () => JSON.parse(localStorage.getItem(KEY) ?? "null");
  // A payer who opens a link without having the app gets an in-memory guest store.
  const guest = () => ({ user: null, addresses: {}, contacts: [], requests: [] });
  let db = load() ?? guest();
  const save = () => {
    if (db.user) localStorage.setItem(KEY, JSON.stringify(db));
    window.dispatchEvent(new Event("pair-local"));
  };
  const listeners = new Set();
  const fire = () => { db = load() ?? db; for (const cb of listeners) cb(); };
  window.addEventListener("storage", (e) => e.key === KEY && fire());
  window.addEventListener("pair-local", fire);

  const card = () => encodeCard({ v: 1, i: db.user.id, n: db.user.name, c: db.user.color, a: db.addresses });
  const findReq = (id) => db.requests.find((r) => r.id === id);

  function payloadOf(r) {
    return encodeCard({ v: 1, i: r.id, k: r.kind, t: { i: r.to_user, n: r.receiver_name, c: r.receiver_color },
      p: r.from_user ? { i: r.from_user, n: r.payer_name } : null, f: r.fiat, a: r.fiat_amount, m: r.note, s: r.asset, d: r.receiver_address, u: r.amount_base_units });
  }
  function withView(r) {
    return { ...r, crypto: cryptoLine(r.amount_base_units, r.asset, "mock"), status_text: statusText(r, db.user.id), pay_path: `#/r/${r.payload}` };
  }
  function payView(r) {
    return {
      id: r.id, kind: r.kind, status: r.status, status_text: statusText(r, r.from_user ?? "anyone"),
      receiver: { id: r.to_user, name: r.receiver_name, color: r.receiver_color },
      payer: r.from_user ? { id: r.from_user, name: r.payer_name } : null,
      fiat: r.fiat, fiat_amount: r.fiat_amount, note: r.note, asset: r.asset, asset_label: ASSETS[r.asset].label,
      network: networkOf(r.asset, "mock").name, crypto: cryptoLine(r.amount_base_units, r.asset, "mock"),
      receiver_address: r.receiver_address,
      payment_uri: paymentUri({ assetId: r.asset, address: r.receiver_address, baseUnits: r.amount_base_units, mode: "mock", message: r.note ? `send21 pair: ${r.note}` : "send21 pair" }),
      pay_url: null, source: "static", testnet: true, tx_id: r.tx_id ?? null, receipt: r.receipt ?? null,
    };
  }
  function fromPayload(enc) {
    const p = decodeCard(enc);
    if (p.v !== 1 || !ASSETS[p.s]) throw new Error("This payment link is not valid");
    return { id: p.i, kind: p.k, to_user: p.t.i, receiver_name: p.t.n, receiver_color: p.t.c, from_user: p.p?.i ?? null, payer_name: p.p?.n ?? null,
      fiat: p.f, fiat_amount: p.a, note: p.m ?? null, asset: p.s, receiver_address: p.d, amount_base_units: p.u, status: "awaiting", payload: enc, created_at: Date.now() };
  }
  function move(id, status, extra = {}) {
    const r = findReq(id); // always the current object: fire() reloads db from storage
    if (!r || !canMove(r.status, status)) return false;
    Object.assign(r, { status, updated_at: Date.now() }, extra);
    save();
    return true;
  }

  return {
    kind: "static",
    async config() {
      return { mode: "mock", testnet: true, static: true, fiats: FIATS, vapidPublicKey: null, demoAddresses: DEMO_ADDRESSES,
        assets: assetsFor("mock").map((id) => ({ id, label: ASSETS[id].label, network: networkOf(id, "mock").name })) };
    },
    hasUser: () => !!db.user,
    async signup({ name, fiat }) {
      const id = uuid();
      db = { user: { id, name: String(name).trim().slice(0, 40), fiat, color: avatarColor(id) }, addresses: { ...DEMO_ADDRESSES }, contacts: [], requests: [] };
      save();
      return db.user;
    },
    forget() { localStorage.removeItem(KEY); db = guest(); },
    async me() {
      return { user: { ...db.user, pair_url: `${base()}#/p/${card()}` }, addresses: db.addresses, contacts: db.contacts,
        activity: [...db.requests].sort((a, b) => b.created_at - a.created_at).map(withView) };
    },
    async updateMe({ name, fiat, addresses }) {
      if (name) db.user.name = String(name).trim().slice(0, 40);
      if (fiat) db.user.fiat = fiat;
      if (addresses) db.addresses = Object.fromEntries(Object.entries(addresses).filter(([, v]) => v));
      save();
      return { ok: true };
    },
    async resetPairCode() { return { ok: true } },
    async pairInfo(code) {
      const c = decodeCard(code);
      if (c.v !== 1 || !c.i || !c.n) throw new Error("This link is not valid");
      return { name: c.n, color: c.c };
    },
    async addContact(code) {
      const c = decodeCard(code);
      if (c.i === db.user.id) throw new Error("That's your own code");
      const already = db.contacts.some((x) => x.id === c.i);
      db.contacts = db.contacts.filter((x) => x.id !== c.i);
      db.contacts.unshift({ id: c.i, name: c.n, color: c.c, accepts: Object.keys(c.a ?? {}), addresses: c.a ?? {} });
      save();
      return { contact: { id: c.i, name: c.n, color: c.c }, already, oneWay: true };
    },
    async removeContact(id) { db.contacts = db.contacts.filter((x) => x.id !== id); save(); },
    async createRequests({ kind, contactIds = [], amount, fiat, note, includeMe = true }) {
      fiat ??= db.user.fiat;
      const total = Math.round(Number(amount) * 100) / 100;
      if (!(total > 0) || total > 10000) throw new Error("An amount between 0.01 and 10000, please");
      const me = db.user;
      const mk = (payer, receiver, addresses, share, splitId) => {
        const asset = pickAsset(Object.keys(addresses), fiat, "mock");
        if (!asset) throw new Error(`${receiver.name} hasn't added a wallet address yet`);
        const r = { id: uuid(), kind, split_id: splitId ?? null, split_title: splitId ? note : null, split_parts: null,
          from_user: payer?.id ?? null, payer_name: payer?.name ?? null, payer_color: payer?.color ?? null,
          to_user: receiver.id, receiver_name: receiver.name, receiver_color: receiver.color, created_by: me.id,
          fiat, fiat_amount: share, note: note || null, asset, receiver_address: addresses[asset],
          amount_base_units: mockBaseUnits(share, fiat, asset), status: "awaiting", created_at: Date.now() };
        r.payload = payloadOf(r);
        return r;
      };
      const out = [];
      if (kind === "link") out.push(mk(null, me, db.addresses, total));
      else if (kind === "send") {
        const c = db.contacts.find((x) => x.id === contactIds[0]);
        if (!c) throw new Error("Pick one person to pay");
        out.push(mk(me, c, c.addresses, total));
      } else {
        const people = contactIds.map((id) => db.contacts.find((x) => x.id === id)).filter(Boolean);
        if (!people.length) throw new Error("Pick someone");
        const parts = people.length + (people.length > 1 && includeMe ? 1 : 0);
        const shares = people.length > 1 ? splitAmount(total, parts) : [total];
        const splitId = people.length > 1 ? uuid() : null;
        people.forEach((c, i) => out.push(mk(c, me, db.addresses, shares[i], splitId)));
        if (splitId) out.forEach((r) => (r.split_parts = parts));
      }
      db.requests.push(...out);
      save();
      return out.map(withView);
    },
    /** id is either a local request id or the encoded link payload. */
    async payInfo(id) {
      let r = findReq(id);
      if (!r) {
        const incoming = fromPayload(id);
        r = findReq(incoming.id);
        if (!r) {
          db.requests.push(incoming);
          if (db.user) save();
          r = incoming;
        }
      }
      return payView(r);
    },
    async simulate(id, _k, outcome = "ok") {
      let r = findReq(id) ?? findReq(fromPayload(id).id);
      if (!r) { r = fromPayload(id); db.requests.push(r); }
      const tx = `mock-${uuid().replace(/-/g, "")}`;
      move(r.id, "seen", { tx_id: tx });
      setTimeout(() => {
        if (outcome === "wrong_amount") move(r.id, "review", { review_note: "billed amount differs (simulated)" });
        else move(r.id, "paid", { receipt: encodeCard({ v: 1, i: r.id, x: tx, n: db.user?.name ?? r.payer_name ?? "Someone" }) });
      }, 1500);
      return { ok: true };
    },
    /** A receipt link (#/paid/...) opened by the receiver marks their request paid. */
    async applyReceipt(enc) {
      const p = decodeCard(enc);
      const r = findReq(p.i);
      if (!r) throw new Error("This receipt is for a request that isn't on this phone");
      move(r.id, "paid", { tx_id: p.x });
      return { ...withView(findReq(r.id)), payer_name: r.payer_name ?? p.n };
    },
    async cancel(id) { move(id, "cancelled"); },
    async remind() { return { ok: true }; },
    subscribePay(id, _k, cb) {
      const f = async () => { try { cb(await this.payInfo(id)); } catch { /* gone */ } };
      listeners.add(f);
      return () => listeners.delete(f);
    },
    subscribeMe(cb) { const f = () => cb({ type: "refresh" }); listeners.add(f); return () => listeners.delete(f); },
    async savePush() { return { ok: true }; },
    async testPush() { return { ok: true }; },
    pairUrl: (me) => me.user.pair_url,
    payUrl: (r) => `${base()}${r.pay_path}`,
    receiptUrl: (enc) => `${base()}#/paid/${enc}`,
  };
}
