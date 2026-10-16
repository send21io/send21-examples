import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSETS, FIATS, FINAL, MAX_AMOUNT, REQUEST_TTL_MS, assetsFor, avatarColor, canMove, cleanText, cryptoLine, networkOf, parseAmount, pickAsset, splitShares, statusText,
  validAddress, DEMO_ADDRESSES,
} from "../web/lib/core.js";
import { openDb, tx } from "./db.js";
import { makeProvider, Send21Error } from "./send21.js";
import { DELIVERY_HEADER, signV2, verifyDelivery } from "./verify.js";
import { loadVapid, sendPush } from "./webpush.js";

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));
const MAX_BODY = 64 * 1024;
const now = () => Date.now();
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const token = (n = 24) => randomBytes(n).toString("base64url");

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

/**
 * Per-client token buckets: `rate` requests per minute with a burst of `burst`. In memory, per
 * process: enough for a prototype; put a shared limiter (or the proxy's) in front in production.
 */
export function rateLimiter({ rate, burst }) {
  const buckets = new Map();
  return (key, t = Date.now()) => {
    let b = buckets.get(key);
    if (!b) { b = { tokens: burst, at: t }; buckets.set(key, b); }
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 60_000) * rate);
    b.at = t;
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.tokens >= burst) buckets.delete(k);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.ceil(((1 - b.tokens) / rate) * 60); // seconds until the next token
  };
}

/**
 * @param {object} config
 * @param {"mock"|"demo"|"api"} config.mode
 * @param {string} config.dbFile
 * @param {string} [config.apiKey] scoped key (drafts:read, drafts:write), api mode only
 * @param {string} [config.webhookSecret] signing secret; mock mode makes one up
 * @param {string} [config.publicUrl] e.g. https://pair.example.org (else from Host)
 * @param {boolean} [config.push] send real Web Push (default true)
 * @param {string} [config.vapidFile]
 * @param {typeof fetch} [config.fetch] for tests
 * @param {Array<string|{dir: string, only?: string[]}>} [config.webDirs] static roots, searched in
 *   order. A white-label app puts its own web/ first, then this app's web/ limited with `only` to
 *   the shared folders (lib/, vendor/).
 * @param {string} [config.memoPrefix] shown in the payer's wallet memo (default "send21 pair")
 * @param {string} [config.bootGlobal] window global that config.js sets (default "SEND21_PAIR")
 * @param {string} [config.liveEnv] env var named in the api-mode safety error (default "PAIR_ALLOW_LIVE")
 */
export function createApp(config) {
  const mode = config.mode ?? "mock";
  if (mode === "api" && !config.allowLive) {
    throw new Error(`api mode uses send21's LIVE networks (send21 accounts have no testnets). Set ${config.liveEnv ?? "PAIR_ALLOW_LIVE"}=1 if you really mean it.`);
  }
  if (mode === "api" && !config.webhookSecret) throw new Error("SEND21_WEBHOOK_SECRET is required in api mode");
  const webhookSecret = config.webhookSecret ?? token(32);
  const db = openDb(config.dbFile ?? ":memory:");
  const provider = config.provider ?? makeProvider({ mode, apiKey: config.apiKey }, config.fetch);
  const pushOn = config.push !== false;
  const vapid = pushOn && config.vapidFile ? loadVapid(config.vapidFile) : pushOn ? loadVapid(join(config.dataDir ?? "data", "vapid.json")) : null;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const log = config.log ?? ((...a) => console.log(...a));
  const webDirs = config.webDirs?.length ? config.webDirs : [WEB_DIR];
  const memoPrefix = config.memoPrefix ?? "send21 pair";
  const bootGlobal = /^[A-Za-z_$][\w$]*$/.test(config.bootGlobal ?? "") ? config.bootGlobal : "SEND21_PAIR";
  // Rate limits per client IP (or X-Forwarded-For behind PAIR_TRUST_PROXY): writes, sign-ups and the webhook.
  const limits = config.rateLimit === false ? null : {
    write: rateLimiter({ rate: 60, burst: 30, ...config.rateLimit?.write }),
    signup: rateLimiter({ rate: 6, burst: 10, ...config.rateLimit?.signup }),
    webhook: rateLimiter({ rate: 600, burst: 200, ...config.rateLimit?.webhook }),
  };

  // ---- statements -------------------------------------------------------
  const q = {
    userByToken: db.prepare("SELECT * FROM users WHERE token_hash = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    userByCode: db.prepare("SELECT * FROM users WHERE pair_code = ?"),
    insertUser: db.prepare("INSERT INTO users (id, name, fiat, color, pair_code, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    updateUser: db.prepare("UPDATE users SET name = ?, fiat = ? WHERE id = ?"),
    resetCode: db.prepare("UPDATE users SET pair_code = ? WHERE id = ?"),
    addresses: db.prepare("SELECT asset, address FROM addresses WHERE user_id = ?"),
    upsertAddress: db.prepare("INSERT INTO addresses (user_id, asset, address) VALUES (?, ?, ?) ON CONFLICT (user_id, asset) DO UPDATE SET address = excluded.address"),
    deleteAddresses: db.prepare("DELETE FROM addresses WHERE user_id = ?"),
    addContact: db.prepare("INSERT INTO contacts (user_id, contact_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING"),
    removeContact: db.prepare("DELETE FROM contacts WHERE (user_id = ? AND contact_id = ?) OR (user_id = ? AND contact_id = ?)"),
    isContact: db.prepare("SELECT 1 FROM contacts WHERE user_id = ? AND contact_id = ?"),
    contacts: db.prepare("SELECT u.id, u.name, u.color FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.user_id = ? ORDER BY c.created_at DESC"),
    insertSplit: db.prepare("INSERT INTO splits (id, owner, title, fiat, total, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    insertRequest: db.prepare(`INSERT INTO requests (id, kind, split_id, from_user, to_user, created_by, fiat, fiat_amount, note, asset, network, currency,
      receiver_address, amount_base_units, draft_id, payment_uri, pay_url, payment_request_id, options_json, idempotency_key, pay_key, status, source, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting', ?, ?, ?, ?)`),
    requestById: db.prepare("SELECT * FROM requests WHERE id = ?"),
    requestByDraft: db.prepare("SELECT * FROM requests WHERE draft_id = ?"),
    requestByPaymentRequest: db.prepare("SELECT * FROM requests WHERE payment_request_id = ?"),
    requestByIdem: db.prepare("SELECT * FROM requests WHERE idempotency_key = ?"),
    setStatus: db.prepare("UPDATE requests SET status = ?, tx_id = COALESCE(?, tx_id), review_note = COALESCE(?, review_note), updated_at = ? WHERE id = ?"),
    setLate: db.prepare("UPDATE requests SET late_tx_id = ?, late_state = ?, late_event = ?, late_amount = ?, late_at = ?, updated_at = ? WHERE id = ?"),
    dueMock: db.prepare("SELECT * FROM requests WHERE source = 'mock' AND status IN ('awaiting', 'seen') AND expires_at IS NOT NULL AND expires_at <= ?"),
    activity: db.prepare(`SELECT r.*, ru.name AS receiver_name, ru.color AS receiver_color, pu.name AS payer_name, pu.color AS payer_color, s.title AS split_title, s.parts AS split_parts
      FROM requests r JOIN users ru ON ru.id = r.to_user LEFT JOIN users pu ON pu.id = r.from_user LEFT JOIN splits s ON s.id = r.split_id
      WHERE r.to_user = ? OR r.from_user = ? ORDER BY r.created_at DESC LIMIT 60`),
    openDemo: db.prepare("SELECT * FROM requests WHERE source = 'demo' AND status IN ('awaiting', 'seen')"),
    insertDelivery: db.prepare("INSERT INTO deliveries (delivery_id, event, request_id, outcome, received_at) VALUES (?, ?, NULL, 'pending', ?) ON CONFLICT (delivery_id) DO NOTHING"),
    finishDelivery: db.prepare("UPDATE deliveries SET request_id = ?, outcome = ? WHERE delivery_id = ?"),
    deliveryCount: db.prepare("SELECT COUNT(*) AS n FROM deliveries"),
    upsertPush: db.prepare("INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth"),
    pushFor: db.prepare("SELECT * FROM push_subs WHERE user_id = ?"),
    deletePush: db.prepare("DELETE FROM push_subs WHERE endpoint = ?"),
  };

  // ---- live updates: SSE + push ----------------------------------------
  const userStreams = new Map(); // userId -> Set<res>
  const payStreams = new Map(); // requestId -> Set<res>
  const addStream = (map, key, res) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(res);
    res.on("close", () => map.get(key)?.delete(res));
  };
  const emit = (map, key, data) => {
    for (const res of map.get(key) ?? []) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    for (const map of [userStreams, payStreams]) for (const set of map.values()) for (const res of set) res.write(": ping\n\n");
  }, 25_000);
  heartbeat.unref();

  const pushLog = [];
  async function notify(userId, note) {
    if (!userId) return;
    emit(userStreams, userId, { type: "notify", ...note });
    if (!vapid) return;
    for (const sub of q.pushFor.all(userId)) {
      try {
        const status = await sendPush(sub, note, vapid, { fetch: fetchImpl });
        pushLog.push({ userId, status });
        if (status === 404 || status === 410) q.deletePush.run(sub.endpoint);
      } catch (err) {
        log("push failed:", err.message);
      }
    }
  }
  function refresh(...userIds) {
    for (const id of new Set(userIds.filter(Boolean))) emit(userStreams, id, { type: "refresh" });
  }

  // ---- helpers ----------------------------------------------------------
  const addressMap = (userId) => Object.fromEntries(q.addresses.all(userId).map((r) => [r.asset, r.address]));
  const publicUser = (u) => u && { id: u.id, name: u.name, color: u.color };
  const origin = (req) => config.publicUrl ?? `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host}`;
  const payLink = (req, r) => `${origin(req)}/r/${r.id}?k=${r.pay_key}`;

  function authUser(req, url) {
    const h = String(req.headers.authorization ?? "");
    const t = h.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("t");
    const u = t ? q.userByToken.get(sha256(t)) : null;
    if (!u) throw new HttpError(401, "Not signed in on this device");
    return u;
  }

  function cleanName(name) {
    // No control, zero-width or bidi-override characters (a name must not read as someone else's).
    const s = cleanText(name, 41);
    if (!s || [...s].length > 40) throw new HttpError(400, "A name of 1 to 40 characters, please");
    return s;
  }
  function cleanFiat(f) {
    const s = String(f ?? "").toUpperCase();
    if (!FIATS.includes(s)) throw new HttpError(400, `Unsupported currency ${s}`);
    return s;
  }
  function saveAddresses(userId, addresses) {
    if (!addresses || typeof addresses !== "object") return;
    const allowed = new Set(assetsFor(mode));
    for (const [asset, address] of Object.entries(addresses)) {
      if (!allowed.has(asset)) throw new HttpError(400, `Unknown asset ${asset}`);
      if (address === "" || address == null) continue;
      if (!validAddress(asset, address, mode)) throw new HttpError(400, `That doesn't look like a ${ASSETS[asset].label} address on ${networkOf(asset, mode).name}`);
    }
    q.deleteAddresses.run(userId);
    for (const [asset, address] of Object.entries(addresses)) if (address) q.upsertAddress.run(userId, asset, String(address).trim());
  }

  const lateOf = (r) => r.late_tx_id ? { tx_id: r.late_tx_id, state: r.late_state, event: r.late_event, amount: r.late_amount, at: r.late_at } : null;
  function view(r, me) {
    const c = r.amount_base_units ? cryptoLine(r.amount_base_units, r.asset, mode) : null;
    return {
      id: r.id, kind: r.kind, split_id: r.split_id, split_title: r.split_title ?? null, split_parts: r.split_parts ?? null,
      from_user: r.from_user, to_user: r.to_user, created_by: r.created_by,
      receiver_name: r.receiver_name, receiver_color: r.receiver_color, payer_name: r.payer_name, payer_color: r.payer_color,
      fiat: r.fiat, fiat_amount: r.fiat_amount, note: r.note, asset: r.asset, crypto: c,
      status: r.status, status_text: statusText(r, me), tx_id: r.tx_id, review_note: r.review_note,
      created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at, late: lateOf(r),
      // Only the people in the request get the link (with its secret).
      pay_path: `/r/${r.id}?k=${r.pay_key}`,
    };
  }

  function activityFor(userId) {
    return q.activity.all(userId, userId).map((r) => view(r, userId));
  }

  function payView(r) {
    const receiver = q.userById.get(r.to_user);
    const payer = r.from_user ? q.userById.get(r.from_user) : null;
    const withNames = { ...r, receiver_name: receiver.name, payer_name: payer?.name };
    return {
      id: r.id, kind: r.kind, status: r.status,
      status_text: statusText(withNames, r.from_user ?? "anyone"),
      receiver: publicUser(receiver), payer: publicUser(payer),
      fiat: r.fiat, fiat_amount: r.fiat_amount, note: r.note,
      asset: r.asset, asset_label: ASSETS[r.asset].label, network: networkOf(r.asset, mode)?.name,
      crypto: r.amount_base_units ? cryptoLine(r.amount_base_units, r.asset, mode) : null,
      receiver_address: r.receiver_address, payment_uri: r.payment_uri, pay_url: r.pay_url,
      source: r.source, testnet: r.source !== "api", tx_id: r.tx_id, review_note: r.review_note, expires_at: r.expires_at,
      late: lateOf(r),
    };
  }

  // ---- status changes ---------------------------------------------------
  /** Move a request (never backwards); returns true when it changed. Call inside or outside a tx. */
  function move(r, status, { txId = null, note = null } = {}) {
    if (!canMove(r.status, status)) return false;
    q.setStatus.run(status, txId, note, now(), r.id);
    return true;
  }
  function afterMove(r, status) {
    const fresh = q.requestById.get(r.id);
    emit(payStreams, r.id, { type: "status", status, request: payView(fresh) });
    refresh(r.to_user, r.from_user);
    const receiver = q.userById.get(r.to_user);
    const payer = r.from_user ? q.userById.get(r.from_user) : null;
    const amount = `${fmtAmount(r.fiat_amount)} ${r.fiat}`;
    const url = `/#/r/${r.id}?k=${r.pay_key}`;
    if (status === "paid") {
      notify(r.to_user, { title: `${payer?.name ?? "Someone"} paid ✓`, body: `${amount}${r.note ? ` · ${r.note}` : ""}`, url, tag: r.id });
      if (payer) notify(payer.id, { title: "Paid ✓", body: `${amount} to ${receiver.name}`, url, tag: r.id });
    } else if (status === "review") {
      notify(r.to_user, { title: "Amount mismatch", body: `A payment for ${amount} arrived with a different amount or asset. Check your wallet.`, url, tag: r.id });
    } else if (status === "late") {
      const fresh = q.requestById.get(r.id);
      notify(r.to_user, { title: "Payment after close", body: `${amount} arrived after this request was ${fresh.late_state}. Check your wallet.`, url, tag: `${r.id}-late` });
    } else if (status === "seen") {
      notify(r.to_user, { title: `${payer?.name ?? "Someone"} is paying…`, body: amount, url, tag: r.id });
    }
  }
  const fmtAmount = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

  // ---- requests ---------------------------------------------------------
  async function createOne({ creator, kind, payer, receiver, fiat, amount, note, splitId, idemKey }) {
    const existing = q.requestByIdem.get(idemKey);
    if (existing) {
      if (existing.created_by !== creator.id) throw new HttpError(409, "Key already used");
      if (existing.fiat_amount !== amount || existing.fiat !== fiat || existing.to_user !== receiver.id || (existing.from_user ?? null) !== (payer?.id ?? null)) {
        // Same rule as send21: a reused Idempotency-Key with another amount, currency or receiver is refused.
        throw new HttpError(422, "This request was already sent with different details");
      }
      return { row: existing, created: false };
    }
    // The receiver's address comes from the receiver's own profile, server-side.
    const addresses = addressMap(receiver.id);
    const assetId = pickAsset(Object.keys(addresses), fiat, mode);
    if (!assetId) throw new HttpError(409, `${receiver.name} hasn't added a wallet address yet`);
    const receiverAddress = addresses[assetId];
    const id = randomUUID();
    const memo = `${memoPrefix} ${id.slice(0, 8)}${note ? `: ${note}` : ""}`.slice(0, 100);
    let d;
    let paymentRequestId = null;
    let optionsJson = null;
    try {
      if (kind === "link" && mode === "api") {
        const options = Object.entries(addresses).filter(([a]) => networkOf(a, mode)).map(([assetId, address]) => ({ assetId, address }));
        const pr = await provider.createPayLink({ options, fiat, fiatAmount: amount, memo, orderId: id, idempotencyKey: idemKey });
        paymentRequestId = pr.paymentRequestId;
        optionsJson = JSON.stringify(options);
        d = { draftId: null, network: networkOf(assetId, mode).network, currency: ASSETS[assetId].currency, receiverAddress, amountBaseUnits: 0, paymentUri: null, payUrl: pr.payUrl, expiresAt: pr.expiresAt };
      } else {
        d = await provider.createDraft({ assetId, receiverAddress, fiat, fiatAmount: amount, memo, idempotencyKey: idemKey });
      }
    } catch (err) {
      if (err instanceof Send21Error) throw new HttpError(502, `send21: ${err.message}`);
      throw err;
    }
    if (mode !== "demo" && d.receiverAddress !== receiverAddress) throw new HttpError(502, "Receiver address changed in transit");
    const t = now();
    try {
      q.insertRequest.run(id, kind, splitId ?? null, payer?.id ?? null, receiver.id, creator.id, fiat, amount, note ?? null, assetId,
        d.network, d.currency, d.receiverAddress, d.amountBaseUnits, d.draftId, d.paymentUri, d.payUrl, paymentRequestId, optionsJson,
        idemKey, token(18), mode, d.expiresAt ?? t + REQUEST_TTL_MS, t, t);
    } catch (err) {
      const again = q.requestByIdem.get(idemKey); // a concurrent double tap won the race
      if (again) return { row: again, created: false };
      throw err;
    }
    return { row: q.requestById.get(id), created: true };
  }

  async function createRequests(me, body, req) {
    const kind = body.kind;
    if (!["request", "send", "link"].includes(kind)) throw new HttpError(400, "kind is request, send or link");
    const fiat = cleanFiat(body.fiat ?? me.fiat);
    // One strict parser for the browser and the server: digits, one separator, the currency's own decimals.
    const parsed = parseAmount(body.amount, fiat, { max: MAX_AMOUNT });
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const total = parsed.value;
    const note = cleanText(body.note, 80) || null;
    const clientKey = String(body.clientKey ?? "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientKey)) throw new HttpError(400, "clientKey (8-64 url-safe characters) is required");
    const ids = [...new Set(Array.isArray(body.contactIds) ? body.contactIds : [])];
    for (const cid of ids) if (!q.isContact.get(me.id, cid)) throw new HttpError(403, "You can only ask your contacts");

    const created = [];
    if (kind === "link") {
      created.push(await createOne({ creator: me, kind, payer: null, receiver: me, fiat, amount: total, note, idemKey: `pair-${clientKey}-0` }));
    } else if (kind === "send") {
      if (ids.length !== 1) throw new HttpError(400, "Pick one person to pay");
      const receiver = q.userById.get(ids[0]);
      created.push(await createOne({ creator: me, kind, payer: me, receiver, fiat, amount: total, note, idemKey: `pair-${clientKey}-0` }));
    } else {
      if (ids.length < 1 || ids.length > 25) throw new HttpError(400, "Pick 1 to 25 people");
      const parts = ids.length + (ids.length > 1 && body.includeMe !== false ? 1 : 0);
      const shares = splitShares(total, ids.length, body.includeMe !== false, fiat).friends;
      if (shares.some((x) => !(x > 0))) throw new HttpError(400, "That's too little to split");
      let splitId = null;
      if (ids.length > 1) {
        splitId = `split-${clientKey}`;
        db.prepare("INSERT INTO splits (id, owner, title, fiat, total, parts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .run(splitId, me.id, note, fiat, total, parts, now());
      }
      for (const [i, cid] of ids.entries()) {
        const payer = q.userById.get(cid);
        created.push(await createOne({ creator: me, kind, payer, receiver: me, fiat, amount: shares[i], note, splitId, idemKey: `pair-${clientKey}-${i}` }));
      }
    }
    for (const { row: r, created: isNew } of created) {
      if (!isNew) continue;
      if (r.kind === "request") {
        notify(r.from_user, { title: `${me.name} asks for ${fmtAmount(r.fiat_amount)} ${r.fiat}`, body: r.note ? `For: ${r.note}. Tap to pay.` : "Tap to pay.", url: `/#/r/${r.id}?k=${r.pay_key}`, tag: r.id });
      } else if (r.kind === "send") {
        notify(r.to_user, { title: `${me.name} is sending you ${fmtAmount(r.fiat_amount)} ${r.fiat}`, body: "You'll get a ✓ when it arrives.", url: `/#/r/${r.id}?k=${r.pay_key}`, tag: r.id });
      }
      refresh(r.to_user, r.from_user);
    }
    const all = q.activity.all(me.id, me.id);
    const rows = created.map(({ row }) => all.find((x) => x.id === row.id) ?? row);
    return rows.map((r) => ({ ...view(r, me.id), pay_url_full: payLink(req, r) }));
  }

  // ---- webhooks ---------------------------------------------------------
  /** Does a draft.confirmed match what we stored? Returns null when it does, else why not. */
  function mismatch(r, data) {
    const sentCurrency = String(data.sentCurrency ?? "").toLowerCase();
    if (r.options_json) {
      const opts = JSON.parse(r.options_json);
      const ok = opts.some(({ assetId }) => ASSETS[assetId].currency.toLowerCase() === sentCurrency && networkOf(assetId, mode).network === data.network);
      if (!ok) return `paid in ${data.sentCurrency} on ${data.network}, which wasn't offered`;
      if (data.fiatCurrency && (data.fiatCurrency !== r.fiat || Number(data.fiatAmount) !== r.fiat_amount)) return `priced ${data.fiatAmount} ${data.fiatCurrency}, expected ${r.fiat_amount} ${r.fiat}`;
      return null;
    }
    if (sentCurrency !== r.currency.toLowerCase()) return `paid in ${data.sentCurrency}, expected ${r.currency.toUpperCase()}`;
    if (data.network !== r.network) return `paid on ${data.network}, expected ${r.network}`;
    // The amount must be there and equal to what we stored. A delivery without it is not a payment we can match.
    if (data.amountSats === undefined || data.amountSats === null) return "no amount in the delivery";
    if (Number(data.amountSats) !== r.amount_base_units) return `billed ${data.amountSats} base units, expected ${r.amount_base_units}`;
    return null;
  }

  /**
   * Verify, dedupe and apply one delivery. The delivery id and the request
   * update are committed in one transaction (as in webhook-receiver-sqlite).
   * @returns {{ status: number, outcome: string }}
   */
  function handleWebhook(rawBody, headers) {
    const { valid } = verifyDelivery(rawBody, headers, webhookSecret, { allowLegacy: false });
    if (!valid) return { status: 401, outcome: "bad_signature" };
    let payload;
    try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return { status: 400, outcome: "bad_json" }; }
    const deliveryId = String(headers[DELIVERY_HEADER]);
    const data = payload.data ?? {};
    let changed = null;
    let target = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (q.insertDelivery.run(deliveryId, String(payload.event), now()).changes === 0) {
        db.exec("ROLLBACK");
        return { status: 200, outcome: "duplicate" };
      }
      const r = (data.draftId && q.requestByDraft.get(data.draftId))
        || (data.paymentRequestId && q.requestByPaymentRequest.get(data.paymentRequestId))
        || (data.orderId && q.requestById.get(data.orderId));
      let outcome = "ignored";
      // Money that arrives on a request that is already closed. Closed states are final, so the
      // request keeps its state; we record the transaction and show a "Payment after close" notice.
      const MONEY = new Set(["draft.seen", "draft.confirmed", "draft.amount_mismatch", "draft.mismatch_unresolved", "draft.mismatch_accepted"]);
      const isLate = r && FINAL.has(r.status) && MONEY.has(payload.event) && data.txId
        && !(r.status === "paid" && r.tx_id === data.txId) && r.late_tx_id !== data.txId;
      if (!r) outcome = "unknown_draft";
      else if (isLate) {
        target = r;
        q.setLate.run(String(data.txId).slice(0, 200), r.status, String(payload.event), data.receivedAmount ?? data.sentAmount ?? null, now(), now(), r.id);
        outcome = "after_close";
        changed = "late";
      } else {
        target = r;
        switch (payload.event) {
          case "draft.seen":
            outcome = move(r, "seen", { txId: data.txId ?? null }) ? ((changed = "seen"), "seen") : "no_change";
            break;
          case "draft.confirmed": {
            const why = mismatch(r, data);
            if (why) {
              outcome = move(r, "review", { txId: data.txId ?? null, note: why }) ? ((changed = "review"), "mismatch") : "no_change";
            } else {
              const accepted = data.receivedAmountSats !== undefined ? `different amount accepted: ${data.receivedAmount ?? data.receivedAmountSats}` : null;
              outcome = move(r, "paid", { txId: data.txId ?? null, note: accepted }) ? ((changed = "paid"), "paid") : "no_change";
            }
            break;
          }
          case "draft.amount_mismatch":
            outcome = move(r, "review", { txId: data.txId ?? null, note: `received ${data.receivedAmount ?? data.receivedAmountSats}, billed ${data.sentAmount ?? data.amountSats}` })
              ? ((changed = "review"), "mismatch") : "no_change";
            break;
          case "draft.mismatch_rejected":
          case "draft.mismatch_unresolved":
            outcome = "review_kept";
            break;
          case "draft.expired":
          case "payment_request.expired":
            outcome = move(r, "expired") ? ((changed = "expired"), "expired") : "no_change";
            // Expired while a transfer with another amount was undecided: money arrived, nobody decided.
            if (outcome === "expired" && data.receivedAmountSats !== undefined && data.txId) {
              q.setLate.run(String(data.txId).slice(0, 200), "expired", String(payload.event), data.receivedAmount ?? null, now(), now(), r.id);
              outcome = "expired_with_payment";
            }
            break;
          case "draft.cancelled":
            outcome = move(r, "cancelled") ? ((changed = "cancelled"), "cancelled") : "no_change";
            break;
          default:
            outcome = "ignored"; // draft.created, draft.mismatch_accepted (confirmed follows), test
        }
      }
      q.finishDelivery.run(target?.id ?? null, outcome, deliveryId);
      db.exec("COMMIT");
      if (changed) afterMove(target, changed); // only after COMMIT
      return { status: 200, outcome };
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /** Mock mode: sign send21-shaped deliveries and feed them through the real webhook path. */
  function simulatedDelivery(event, data) {
    const raw = Buffer.from(JSON.stringify({ event, data }));
    const id = randomUUID();
    const t = Math.floor(now() / 1000);
    return { raw, headers: { "x-send21-event": event, "x-send21-delivery": id, "x-send21-timestamp": String(t), "x-send21-signature-v2": signV2(raw, id, t, webhookSecret) } };
  }
  function simulatePayment(r, outcome = "ok") {
    const a = ASSETS[r.asset];
    if (outcome === "expire") {
      const d = simulatedDelivery("draft.expired", { draftId: r.draft_id, status: "Expired", network: r.network });
      return handleWebhook(d.raw, d.headers);
    }
    const base = {
      draftId: r.draft_id, network: r.network, sentCurrency: a.currency.toUpperCase(), amountSats: r.amount_base_units,
      sentAmount: cryptoLine(r.amount_base_units, r.asset, mode).exact, fiatCurrency: r.fiat, fiatAmount: r.fiat_amount,
      txId: `mock-${randomBytes(16).toString("hex")}`,
    };
    if (outcome === "wrong_amount") base.amountSats = r.amount_base_units + 1;
    if (outcome === "late") {
      // A payment that lands after the request was closed, through the real verification path.
      const late = simulatedDelivery("draft.confirmed", { ...base, status: "Confirmed", confirmations: 1, occurredAt: new Date().toISOString() });
      return handleWebhook(late.raw, late.headers);
    }
    const seen = simulatedDelivery("draft.seen", { ...base, status: "Seen", confirmations: 0 });
    handleWebhook(seen.raw, seen.headers);
    const confirmed = simulatedDelivery("draft.confirmed", { ...base, status: "Confirmed", confirmations: 1, occurredAt: new Date().toISOString() });
    const delay = config.simulateDelayMs ?? 1500;
    const run = () => {
      handleWebhook(confirmed.raw, confirmed.headers);
      handleWebhook(confirmed.raw, confirmed.headers); // send21 retries reuse the delivery id: shows the dedupe
    };
    if (delay > 0) setTimeout(run, delay).unref(); else run();
  }

  const simulating = new Set();
  // Mock mode stands in for send21's draft.expired: past-due requests get a signed expiry delivery.
  function sweepMock() {
    for (const r of q.dueMock.all(now())) {
      const d = simulatedDelivery("draft.expired", { draftId: r.draft_id, status: "Expired", network: r.network });
      try { handleWebhook(d.raw, d.headers); } catch (err) { log("expiry sweep:", err.message); }
    }
  }
  const sweeper = mode === "mock" ? setInterval(sweepMock, config.sweepMs ?? 30_000) : null;
  sweeper?.unref();

  // ---- demo mode: poll the public demo API (it has no webhooks) --------
  async function pollDemo() {
    for (const r of q.openDemo.all()) {
      try {
        const d = await provider.getDraft(r.draft_id);
        const map = { Seen: "seen", Confirmed: "paid", Expired: "expired", Cancelled: "cancelled" };
        let next = map[d.status];
        if (next === "paid" && Number(d.amountBaseUnits) !== r.amount_base_units) next = "review";
        if (next && move(r, next, { txId: d.paidTxId ?? null })) afterMove(r, next);
      } catch (err) {
        log("demo poll:", err.message);
      }
    }
  }
  const poller = mode === "demo" ? setInterval(pollDemo, config.pollMs ?? 8000) : null;
  poller?.unref();

  // ---- HTTP -------------------------------------------------------------
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, "Too large");
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  const json = async (req) => {
    const raw = await readBody(req);
    try { return raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { throw new HttpError(400, "Bad JSON"); }
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const sse = (res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
  };

  const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json",
    ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
  const SECURITY = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  };
  async function serveStatic(res, pathname) {
    const rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(/^([/\\])+/, "");
    if (rel.startsWith("..")) throw new HttpError(404, "Not found");
    let file, body;
    for (const root of webDirs) {
      const { dir, only } = typeof root === "string" ? { dir: root } : root;
      if (only && !only.some((pre) => rel.startsWith(pre))) continue;
      try { file = join(dir, rel); body = await readFile(file); break; } catch { body = undefined; }
    }
    if (body === undefined) throw new HttpError(404, "Not found");
    let out = body;
    if (rel === "config.js") out = Buffer.from(`window.${bootGlobal} = { backend: "server", mode: ${JSON.stringify(mode)} };\n`);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": rel === "sw.js" || rel === "config.js" ? "no-cache" : "public, max-age=300", ...SECURITY });
    res.end(out);
  }

  const clientIp = (req) => (config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
  function limit(req, p) {
    if (!limits || req.method === "GET" || req.method === "HEAD") return;
    const bucket = p === "/webhooks/send21" ? "webhook" : p === "/api/users" ? "signup" : p.startsWith("/api/") ? "write" : null;
    if (!bucket) return;
    const wait = limits[bucket](`${bucket}:${clientIp(req)}`);
    if (wait) throw new HttpError(429, `Too many requests. Try again in ${wait} s.`, { "Retry-After": String(wait) });
  }

  async function route(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    limit(req, p);
    const m = (re) => p.match(re);
    let mm;

    // Pretty links, also valid without the app: /p/<code> (pairing) and /r/<id>?k= (pay).
    if (req.method === "GET" && (mm = m(/^\/p\/([A-Za-z0-9_-]{6,40})$/))) {
      res.writeHead(302, { Location: `/#/p/${mm[1]}` }); return res.end();
    }
    if (req.method === "GET" && (mm = m(/^\/r\/([0-9a-f-]{36})$/))) {
      res.writeHead(302, { Location: `/#/r/${mm[1]}?k=${encodeURIComponent(url.searchParams.get("k") ?? "")}` }); return res.end();
    }

    if (p === "/webhooks/send21" && req.method === "POST") {
      const raw = await readBody(req);
      const out = handleWebhook(raw, req.headers);
      return send(res, out.status, { outcome: out.outcome });
    }

    if (!p.startsWith("/api/")) return serveStatic(res, p);

    if (p === "/api/config" && req.method === "GET") {
      return send(res, 200, { mode, testnet: mode !== "api", assets: assetsFor(mode).map((id) => ({ id, label: ASSETS[id].label, network: networkOf(id, mode).name })),
        fiats: FIATS, vapidPublicKey: vapid?.publicKey ?? null, demoAddresses: mode === "api" ? null : DEMO_ADDRESSES });
    }
    if (p === "/api/users" && req.method === "POST") {
      const b = await json(req);
      const name = cleanName(b.name);
      const fiat = cleanFiat(b.fiat ?? "USD");
      const id = randomUUID();
      const t = token(32);
      tx(db, () => {
        q.insertUser.run(id, name, fiat, avatarColor(id), token(8), sha256(t), now());
        saveAddresses(id, b.addresses ?? (mode === "api" ? {} : DEMO_ADDRESSES));
      });
      return send(res, 201, { token: t, user: publicUser(q.userById.get(id)) });
    }
    if ((mm = m(/^\/api\/pair\/([A-Za-z0-9_-]{6,40})$/)) && req.method === "GET") {
      const u = q.userByCode.get(mm[1]);
      if (!u) throw new HttpError(404, "This link is no longer valid. Ask for a new one.");
      return send(res, 200, { name: u.name, color: u.color });
    }
    if ((mm = m(/^\/api\/pay\/([0-9a-f-]{36})(\/events|\/simulate)?$/))) {
      const r = q.requestById.get(mm[1]);
      if (!r || r.pay_key !== url.searchParams.get("k")) throw new HttpError(404, "This payment link is not valid");
      if (!mm[2] && req.method === "GET") return send(res, 200, payView(r));
      if (mm[2] === "/events" && req.method === "GET") {
        sse(res); addStream(payStreams, r.id, res);
        return res.write(`data: ${JSON.stringify({ type: "status", status: r.status, request: payView(r) })}\n\n`);
      }
      if (mm[2] === "/simulate" && req.method === "POST") {
        if (mode !== "mock") throw new HttpError(403, "Simulated payments exist in mock mode only");
        const outcome = url.searchParams.get("outcome") ?? "ok";
        if (!["ok", "wrong_amount", "expire", "late"].includes(outcome)) throw new HttpError(400, "Unknown outcome");
        if (outcome === "late") {
          if (!FINAL.has(r.status)) throw new HttpError(409, "Close the request first (cancel or let it expire)");
          return send(res, 200, { ok: true, outcome: simulatePayment(r, "late").outcome });
        }
        if (FINAL.has(r.status)) return send(res, 200, { ok: true, status: r.status });
        if (simulating.has(r.id)) return send(res, 202, { ok: true }); // a double tap simulates once
        if (outcome !== "expire") { simulating.add(r.id); setTimeout(() => simulating.delete(r.id), (config.simulateDelayMs ?? 1500) + 500).unref(); }
        simulatePayment(r, outcome);
        return send(res, 202, { ok: true });
      }
    }

    // Everything below needs the device token.
    const me = authUser(req, url);
    if (p === "/api/me" && req.method === "GET") {
      return send(res, 200, {
        user: { ...publicUser(me), fiat: me.fiat, pair_path: `/p/${me.pair_code}`, pair_url: `${origin(req)}/p/${me.pair_code}` },
        addresses: addressMap(me.id),
        // Contacts carry which assets they accept (for the "≈ 11.42 USDC" line), never their addresses.
        contacts: q.contacts.all(me.id).map((c) => ({ ...c, accepts: Object.keys(addressMap(c.id)) })),
        activity: activityFor(me.id),
      });
    }
    if (p === "/api/me" && req.method === "PUT") {
      const b = await json(req);
      tx(db, () => {
        q.updateUser.run(cleanName(b.name ?? me.name), cleanFiat(b.fiat ?? me.fiat), me.id);
        if (b.addresses) saveAddresses(me.id, b.addresses);
      });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/me/pair-code" && req.method === "POST") {
      q.resetCode.run(token(8), me.id);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/events" && req.method === "GET") {
      sse(res); addStream(userStreams, me.id, res); return;
    }
    if (p === "/api/contacts" && req.method === "POST") {
      const b = await json(req);
      const other = q.userByCode.get(String(b.code ?? ""));
      if (!other) throw new HttpError(404, "This link is no longer valid. Ask for a new one.");
      if (other.id === me.id) throw new HttpError(400, "That's your own code");
      const already = !!q.isContact.get(me.id, other.id);
      tx(db, () => { q.addContact.run(me.id, other.id, now()); q.addContact.run(other.id, me.id, now()); });
      if (!already) notify(other.id, { title: `${me.name} added you`, body: "You can now ask each other for money.", url: "/#/", tag: `contact-${me.id}` });
      refresh(me.id, other.id);
      return send(res, 200, { contact: publicUser(other), already });
    }
    if ((mm = m(/^\/api\/contacts\/([0-9a-f-]{36})$/)) && req.method === "DELETE") {
      q.removeContact.run(me.id, mm[1], mm[1], me.id);
      refresh(me.id, mm[1]);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/requests" && req.method === "POST") {
      return send(res, 201, { requests: await createRequests(me, await json(req), req) });
    }
    if ((mm = m(/^\/api\/requests\/([0-9a-f-]{36})\/(cancel|remind)$/)) && req.method === "POST") {
      const r = q.requestById.get(mm[1]);
      if (!r || r.to_user !== me.id) throw new HttpError(404, "Not found");
      if (mm[2] === "cancel") {
        if (move(r, "cancelled")) afterMove(r, "cancelled");
      } else if (r.from_user && !FINAL.has(r.status)) {
        notify(r.from_user, { title: `Reminder from ${me.name}`, body: `${fmtAmount(r.fiat_amount)} ${r.fiat}${r.note ? ` · ${r.note}` : ""}. Tap to pay.`, url: `/#/r/${r.id}?k=${r.pay_key}`, tag: r.id });
      }
      return send(res, 200, { ok: true });
    }
    if (p === "/api/push" && req.method === "POST") {
      const b = await json(req);
      const s = b.subscription;
      if (!s?.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) throw new HttpError(400, "Bad subscription");
      q.upsertPush.run(s.endpoint, me.id, s.keys.p256dh, s.keys.auth, now());
      return send(res, 200, { ok: true });
    }
    if (p === "/api/push/test" && req.method === "POST") {
      await notify(me.id, { title: "Notifications work ✓", body: "You'll hear when someone asks or pays.", url: "/#/", tag: "test" });
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, "Not found");
  }

  async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong" : err.message }, err.headers ?? {});
      else res.end();
    }
  }

  return {
    handler, db, mode, handleWebhook, simulatePayment, webhookSecret, pollDemo, pushLog,
    sweepMock,
    close() { clearInterval(poller); clearInterval(sweeper); clearInterval(heartbeat); for (const map of [userStreams, payStreams]) for (const set of map.values()) for (const r of set) r.end(); db.close(); },
  };
}
