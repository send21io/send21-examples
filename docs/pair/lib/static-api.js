// Client-side mock backend for the static demo (GitHub Pages). There is no
// server: data stays in this browser (localStorage) and the links and QR codes
// carry what the other phone needs (a contact card, a request, a receipt).
// No send21 call, no key, no real money: TESTNET mock only.
//
// Everything that arrives in a link comes from another phone, so it is checked
// field by field before it is used (ids, names, colors, amounts, assets, addresses).

import {
  ASSETS, DEMO_ADDRESSES, FIATS, FINAL, REQUEST_TTL_MS, assetsFor, avatarColor, canMove, cleanText, cryptoLine, decodeCard, encodeCard,
  mockBaseUnits, networkOf, parseAmount, paymentUri, pickAsset, randomId, splitShares, statusText, validAddress, validColor, validId,
} from "./core.js";

const uuid = () => randomId();
const base = () => location.href.split("#")[0].split("?")[0];
const BAD_LINK = "This link doesn't work. Ask for a new one.";
const fail = (msg = BAD_LINK, code = "bad_link") => Object.assign(new Error(msg), { code });

function decode(s) {
  if (typeof s !== "string" || s.length > 4000 || !/^[A-Za-z0-9_-]+$/.test(s)) throw fail();
  try { return decodeCard(s); } catch { throw fail(); }
}
/** Accepted assets with valid test addresses only. */
function cleanAddresses(a) {
  const out = {};
  if (!a || typeof a !== "object") return out;
  for (const id of assetsFor("mock")) if (typeof a[id] === "string" && validAddress(id, a[id], "mock")) out[id] = a[id].trim();
  return out;
}
/** A contact card (pairing link) from another phone. */
export function readCard(code) {
  const c = decode(code);
  if (!c || c.v !== 1 || !validId(String(c.i ?? "")) ) throw fail();
  const name = cleanText(c.n, 40);
  if (!name) throw fail();
  return { id: c.i, name, color: validColor(c.c) ? c.c : avatarColor(c.i), addresses: cleanAddresses(c.a) };
}
/** A request link from another phone. */
export function readRequest(enc) {
  const p = decode(enc);
  if (!p || p.v !== 1 || !ASSETS[p.s] || !networkOf(p.s, "mock") || !["request", "send", "link"].includes(p.k)) throw fail();
  if (!validId(String(p.i ?? "")) || !validId(String(p.t?.i ?? ""))) throw fail();
  if (p.p && !validId(String(p.p.i ?? ""))) throw fail();
  if (!FIATS.includes(p.f)) throw fail();
  const amt = parseAmount(typeof p.a === "number" ? p.a : NaN, p.f);
  if (!amt.ok) throw fail();
  if (!validAddress(p.s, p.d, "mock")) throw fail();
  const units = p.u;
  if (typeof units !== "number" || !Number.isSafeInteger(units) || units <= 0) throw fail();
  const receiver = cleanText(p.t.n, 40);
  if (!receiver) throw fail();
  const created = Number.isFinite(p.c) ? p.c : Date.now();
  return {
    id: p.i, kind: p.k, to_user: p.t.i, receiver_name: receiver, receiver_color: validColor(p.t.c) ? p.t.c : avatarColor(p.t.i),
    from_user: p.p?.i ?? null, payer_name: p.p ? cleanText(p.p.n, 40) || "Someone" : null,
    fiat: p.f, fiat_amount: amt.value, note: cleanText(p.m, 80) || null, asset: p.s, receiver_address: p.d.trim(), amount_base_units: units,
    status: "awaiting", payload: enc, created_at: created,
    expires_at: Number.isFinite(p.e) ? p.e : created + REQUEST_TTL_MS,
  };
}

/**
 * @param {string} slot test user slot (?as=)
 * @param {{ storagePrefix?: string, memo?: string }} [brand] white-label apps pass their own
 *   localStorage prefix (so apps on one origin don't share data) and wallet memo name.
 */
export function staticApi(slot, { storagePrefix = "pair", memo = "send21 pair" } = {}) {
  const KEY = `${storagePrefix}.static.${slot}`;
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? "null"); } catch { return null; } };
  // A payer who opens a link without having the app gets an in-memory guest store.
  const guest = () => ({ user: null, addresses: {}, contacts: [], requests: [] });
  let db = load() ?? guest();
  const save = () => {
    if (db.user) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* storage full or private mode */ } }
    window.dispatchEvent(new Event("pair-local"));
  };
  const listeners = new Set();
  const fire = () => { db = load() ?? db; for (const cb of listeners) cb(); };
  window.addEventListener("storage", (e) => e.key === KEY && fire());
  window.addEventListener("pair-local", fire);
  // Requests expire while the app is open, too.
  const tick = setInterval(() => { if (db.requests.some(due)) { db.requests.forEach(expireIfDue); save(); } }, 15_000);
  tick.unref?.(); // never keeps a Node test process alive

  const card = () => encodeCard({ v: 1, i: db.user.id, n: db.user.name, c: db.user.color, a: db.addresses });
  const findReq = (id) => db.requests.find((r) => r.id === id);
  const due = (r) => !FINAL.has(r.status) && r.status !== "review" && r.expires_at && r.expires_at <= Date.now();
  function expireIfDue(r) { if (due(r)) Object.assign(r, { status: "expired", updated_at: Date.now() }); return r; }

  function payloadOf(r) {
    return encodeCard({ v: 1, i: r.id, k: r.kind, t: { i: r.to_user, n: r.receiver_name, c: r.receiver_color },
      p: r.from_user ? { i: r.from_user, n: r.payer_name } : null, f: r.fiat, a: r.fiat_amount, m: r.note, s: r.asset, d: r.receiver_address, u: r.amount_base_units,
      c: r.created_at, e: r.expires_at });
  }
  function withView(r) {
    expireIfDue(r);
    return { ...r, crypto: cryptoLine(r.amount_base_units, r.asset, "mock"), status_text: statusText(r, db.user.id), pay_path: `#/r/${r.payload}`, late: r.late ?? null };
  }
  function payView(r) {
    expireIfDue(r);
    return {
      id: r.id, kind: r.kind, status: r.status, status_text: statusText(r, r.from_user ?? "anyone"),
      receiver: { id: r.to_user, name: r.receiver_name, color: r.receiver_color },
      payer: r.from_user ? { id: r.from_user, name: r.payer_name } : null,
      fiat: r.fiat, fiat_amount: r.fiat_amount, note: r.note, asset: r.asset, asset_label: ASSETS[r.asset].label,
      network: networkOf(r.asset, "mock").name, crypto: cryptoLine(r.amount_base_units, r.asset, "mock"),
      receiver_address: r.receiver_address,
      payment_uri: paymentUri({ assetId: r.asset, address: r.receiver_address, baseUnits: r.amount_base_units, mode: "mock", message: r.note ? `${memo}: ${r.note}` : memo }),
      pay_url: null, source: "static", testnet: true, tx_id: r.tx_id ?? null, review_note: r.review_note ?? null, receipt: r.receipt ?? null,
      expires_at: r.expires_at ?? null, late: r.late ?? null,
    };
  }
  function move(id, status, extra = {}) {
    const r = findReq(id); // always the current object: fire() reloads db from storage
    if (!r || !canMove(r.status, status)) return false;
    Object.assign(r, { status, updated_at: Date.now() }, extra);
    save();
    return true;
  }
  /** A payment that lands on a request that is already closed: keep the request as it is, show a notice. */
  function late(id, txId) {
    const r = findReq(id);
    if (!r || !FINAL.has(r.status) || r.late?.tx_id === txId || (r.status === "paid" && r.tx_id === txId)) return false;
    r.late = { tx_id: txId, state: r.status, at: Date.now() };
    save();
    return true;
  }
  const simulating = new Set();
  const mockTx = () => `mock-${uuid().replace(/-/g, "")}`;

  return {
    kind: "static",
    async config() {
      return { mode: "mock", testnet: true, static: true, fiats: FIATS, vapidPublicKey: null, demoAddresses: DEMO_ADDRESSES,
        assets: assetsFor("mock").map((id) => ({ id, label: ASSETS[id].label, network: networkOf(id, "mock").name })) };
    },
    hasUser: () => !!db.user,
    async signup({ name, fiat }) {
      const n = cleanText(name, 40);
      if (!n) throw fail("A name, please", "bad_input");
      const id = uuid();
      db = { user: { id, name: n, fiat: FIATS.includes(fiat) ? fiat : "USD", color: avatarColor(id) }, addresses: { ...DEMO_ADDRESSES }, contacts: [], requests: [] };
      save();
      return db.user;
    },
    forget() { localStorage.removeItem(KEY); db = guest(); },
    async me() {
      return { user: { ...db.user, pair_url: `${base()}#/p/${card()}` }, addresses: db.addresses, contacts: db.contacts,
        activity: [...db.requests].sort((a, b) => b.created_at - a.created_at).map(withView) };
    },
    async updateMe({ name, fiat, addresses }) {
      if (name !== undefined) { const n = cleanText(name, 40); if (!n) throw fail("A name, please", "bad_input"); db.user.name = n; }
      if (fiat && FIATS.includes(fiat)) db.user.fiat = fiat;
      if (addresses) {
        const out = {};
        for (const [id, v] of Object.entries(addresses)) {
          if (!v) continue;
          if (!ASSETS[id] || !validAddress(id, v, "mock")) throw Object.assign(fail(`That doesn't look like a ${ASSETS[id]?.label ?? id} address on ${networkOf(id, "mock")?.name ?? "this network"}`, "bad_address"), { field: id });
          out[id] = v.trim();
        }
        db.addresses = out;
      }
      save();
      return { ok: true };
    },
    async resetPairCode() { return { ok: true }; },
    async pairInfo(code) {
      const c = readCard(code);
      return { name: c.name, color: c.color };
    },
    async addContact(code) {
      const c = readCard(code);
      if (c.id === db.user.id) throw fail("That's your own code", "own_code");
      const already = db.contacts.some((x) => x.id === c.id);
      db.contacts = db.contacts.filter((x) => x.id !== c.id);
      db.contacts.unshift({ id: c.id, name: c.name, color: c.color, accepts: Object.keys(c.addresses), addresses: c.addresses });
      save();
      return { contact: { id: c.id, name: c.name, color: c.color }, already, oneWay: true };
    },
    async removeContact(id) { db.contacts = db.contacts.filter((x) => x.id !== id); save(); },
    async createRequests({ kind, contactIds = [], amount, fiat, note, includeMe = true, clientKey }) {
      // The same form submitted twice (a double tap, a retry) creates the requests once.
      const key = typeof clientKey === "string" && /^[\w-]{8,64}$/.test(clientKey) ? clientKey : null;
      const again = key ? db.requests.filter((r) => r.client_key === key) : [];
      if (again.length) return again.map(withView);
      fiat = FIATS.includes(fiat) ? fiat : db.user.fiat;
      const parsed = parseAmount(amount, fiat);
      if (!parsed.ok) throw fail(parsed.error, "bad_amount");
      const total = parsed.value;
      const cleanNote = cleanText(note, 80) || null;
      const me = db.user;
      const now = Date.now();
      const mk = (payer, receiver, addresses, share, splitId) => {
        const asset = pickAsset(Object.keys(addresses), fiat, "mock");
        if (!asset) throw fail(`${receiver.name} hasn't added a wallet address yet`, "no_wallet");
        const r = { id: uuid(), kind, split_id: splitId ?? null, split_title: splitId ? cleanNote : null, split_parts: null,
          from_user: payer?.id ?? null, payer_name: payer?.name ?? null, payer_color: payer?.color ?? null,
          to_user: receiver.id, receiver_name: receiver.name, receiver_color: receiver.color, created_by: me.id,
          fiat, fiat_amount: share, note: cleanNote, asset, receiver_address: addresses[asset],
          amount_base_units: mockBaseUnits(share, fiat, asset), status: "awaiting", created_at: now, expires_at: now + REQUEST_TTL_MS, client_key: key };
        r.payload = payloadOf(r);
        return r;
      };
      const out = [];
      if (kind === "link") out.push(mk(null, me, db.addresses, total));
      else if (kind === "send") {
        const c = db.contacts.find((x) => x.id === contactIds[0]);
        if (!c) throw fail("Pick one person to pay", "bad_input");
        out.push(mk(me, c, c.addresses, total));
      } else {
        const people = contactIds.map((id) => db.contacts.find((x) => x.id === id)).filter(Boolean);
        if (!people.length) throw fail("Pick someone", "bad_input");
        const parts = people.length + (people.length > 1 && includeMe ? 1 : 0);
        const shares = splitShares(total, people.length, includeMe, fiat).friends;
        if (shares.some((x) => !(x > 0))) throw fail("That's too little to split", "bad_amount");
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
        const incoming = readRequest(id);
        r = findReq(incoming.id);
        if (!r) {
          db.requests.push(incoming);
          if (db.user) save();
          r = incoming;
        }
      }
      return payView(r);
    },
    /**
     * Mock outcomes: "ok" (seen, then paid), "wrong_amount" (mismatch), "expire" (time runs out now),
     * "late" (a payment lands after the request was closed).
     */
    async simulate(id, _k, outcome = "ok") {
      let r = findReq(id) ?? findReq(readRequest(id).id);
      if (!r) { r = readRequest(id); db.requests.push(r); }
      expireIfDue(r);
      if (outcome === "late") return { ok: late(r.id, mockTx()) };
      if (FINAL.has(r.status)) return { ok: false, status: r.status };
      if (outcome === "expire") { r.expires_at = Date.now(); expireIfDue(r); save(); return { ok: true }; }
      if (simulating.has(r.id)) return { ok: true }; // a double tap simulates once
      simulating.add(r.id);
      const tx = mockTx();
      move(r.id, "seen", { tx_id: tx });
      setTimeout(() => {
        simulating.delete(r.id);
        if (outcome === "wrong_amount") move(r.id, "review", { review_note: "Paid 1 base unit more than asked (simulated)" });
        else if (!move(r.id, "paid", { receipt: encodeCard({ v: 1, i: r.id, x: tx, n: db.user?.name ?? r.payer_name ?? "Someone" }) })) save();
      }, 1500);
      return { ok: true };
    },
    /** A receipt link (#/paid/...) opened by the receiver marks their request paid, or flags a payment after close. */
    async applyReceipt(enc) {
      const p = decode(enc);
      if (!p || p.v !== 1 || !validId(String(p.i ?? "")) || typeof p.x !== "string" || !/^[\w-]{4,120}$/.test(p.x)) throw fail();
      const r = findReq(p.i);
      if (!r) throw fail("This receipt is for a request that isn't on this phone", "not_here");
      expireIfDue(r);
      const after = r.status === "expired" || r.status === "cancelled";
      if (after) late(r.id, p.x); else move(r.id, "paid", { tx_id: p.x });
      return { ...withView(findReq(r.id)), payer_name: r.payer_name ?? (cleanText(p.n, 40) || "Someone"), after_close: after };
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
