import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A durable store for send21 webhook deliveries, in one SQLite file.
//
// node:sqlite ships with Node.js (22.13 and later, no flag needed), so there is
// no database server and no dependency. On Node 22 it prints an
// ExperimentalWarning; on Node 24 it does not. With better-sqlite3 the code is
// the same: prepare the same statements and wrap applyDelivery's body in
// db.transaction().
//
// The whole point is one transaction:
//
//   BEGIN IMMEDIATE
//     INSERT INTO deliveries (delivery_id) ... ON CONFLICT DO NOTHING
//     -> no row inserted: this delivery id was committed before, ROLLBACK, "duplicate"
//     apply the bookkeeping update (here: mark the order paid on draft.confirmed)
//   COMMIT
//
// and the HTTP answer is sent only after COMMIT returned. Either the delivery
// id and the update are both on disk, or neither is.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS orders (
  order_id   TEXT PRIMARY KEY,
  draft_id   TEXT,
  status     TEXT NOT NULL,
  tx_id      TEXT,
  paid_at    INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

-- One row per bookkeeping update that was applied. A naive receiver that
-- handles a redelivery again would add a second row here; this one cannot.
CREATE TABLE IF NOT EXISTS ledger (
  id          INTEGER PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries (delivery_id),
  order_id    TEXT NOT NULL,
  draft_id    TEXT,
  tx_id       TEXT,
  amount      TEXT,
  currency    TEXT,
  network     TEXT,
  created_at  INTEGER NOT NULL
) STRICT;
`;

/**
 * Open (or create) the SQLite file. Every call opens a new connection, which is
 * what a process restart does too.
 * @param {string} file path of the database file, or ":memory:"
 */
export function openStore(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL lets readers run while a webhook is written. synchronous=FULL syncs the
  // WAL on every COMMIT, so a committed delivery also survives a power loss, not
  // only a process crash. busy_timeout makes a second process wait for the
  // write lock instead of failing at once.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const statements = {
    insertDelivery: db.prepare(
      "INSERT INTO deliveries (delivery_id, event, received_at) VALUES (?, ?, ?) ON CONFLICT (delivery_id) DO NOTHING",
    ),
    getOrder: db.prepare("SELECT * FROM orders WHERE order_id = ?"),
    markPaid: db.prepare(`
      INSERT INTO orders (order_id, draft_id, status, tx_id, paid_at, updated_at)
      VALUES (?, ?, 'paid', ?, ?, ?)
      ON CONFLICT (order_id) DO UPDATE SET
        draft_id = excluded.draft_id, status = 'paid', tx_id = excluded.tx_id,
        paid_at = excluded.paid_at, updated_at = excluded.updated_at`),
    markSeen: db.prepare(`
      INSERT INTO orders (order_id, draft_id, status, tx_id, updated_at)
      VALUES (?, ?, 'payment_seen', ?, ?)
      ON CONFLICT (order_id) DO UPDATE SET
        draft_id = excluded.draft_id, status = 'payment_seen', tx_id = excluded.tx_id, updated_at = excluded.updated_at
      WHERE orders.status NOT IN ('paid')`),
    insertLedger: db.prepare(`
      INSERT INTO ledger (delivery_id, order_id, draft_id, tx_id, amount, currency, network, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    pruneDeliveries: db.prepare("DELETE FROM deliveries WHERE received_at < ? AND delivery_id NOT IN (SELECT delivery_id FROM ledger)"),
  };

  return { db, statements, close: () => db.close() };
}

/**
 * The bookkeeping update for one event. Runs inside the transaction.
 * Mark an order paid on draft.confirmed only, and never move it backwards.
 * @returns {string} outcome
 */
function applyEvent({ statements }, deliveryId, payload, now) {
  const data = payload.data ?? {};
  const orderId = data.orderId ?? data.draftId;
  switch (payload.event) {
    case "draft.confirmed":
      if (!orderId) return "ignored";
      statements.markPaid.run(orderId, data.draftId ?? null, data.txId ?? null, now, now);
      statements.insertLedger.run(
        deliveryId,
        orderId,
        data.draftId ?? null,
        data.txId ?? null,
        data.receivedAmount ?? data.sentAmount ?? null,
        data.sentCurrency ?? null,
        data.network ?? null,
        now,
      );
      return "order_paid";
    case "draft.seen":
      // Seen, not confirmed. Does not mark the order paid, and a late
      // draft.seen does not move a paid order back (see the WHERE clause).
      if (orderId) statements.markSeen.run(orderId, data.draftId ?? null, data.txId ?? null, now);
      return "payment_seen";
    case "test":
      return "test";
    default:
      // draft.created and every other event: recorded as delivered, nothing
      // else. draft.amount_mismatch and the review events would go to your
      // review list here, in the same transaction.
      return "ignored";
  }
}

/**
 * Record a verified delivery and apply its update in ONE transaction.
 * Returns only after COMMIT, so the caller may answer 2xx when this returns.
 * Throws (after ROLLBACK) when anything fails; then answer 5xx so send21 retries.
 *
 * @param {{ db: DatabaseSync, statements: object }} store from openStore
 * @param {string} deliveryId X-Send21-Delivery (signed by X-Send21-Signature-V2)
 * @param {{ event: string, data?: object }} payload parsed body
 * @param {{ now?: number, beforeCommit?: () => void }} [options] beforeCommit is a test hook
 * @returns {{ outcome: string, duplicate: boolean }}
 */
export function applyDelivery(store, deliveryId, payload, { now = Math.floor(Date.now() / 1000), beforeCommit } = {}) {
  const { db, statements } = store;
  // IMMEDIATE takes the write lock now, so two processes cannot both see the
  // delivery id as new.
  db.exec("BEGIN IMMEDIATE");
  try {
    const { changes } = statements.insertDelivery.run(deliveryId, payload.event, now);
    if (changes === 0) {
      db.exec("ROLLBACK");
      return { outcome: "duplicate", duplicate: true };
    }
    const outcome = applyEvent(store, deliveryId, payload, now);
    beforeCommit?.();
    db.exec("COMMIT");
    return { outcome, duplicate: false };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back (or never started).
    }
    throw err;
  }
}

/**
 * Optional housekeeping: forget delivery ids older than `olderThanSeconds` that
 * did not change anything. Keep ids at least as long as send21 can still retry
 * a delivery (up to 8 attempts with growing gaps) plus a margin; 30 days is
 * a safe default. Ids behind a ledger row are always kept.
 */
export function pruneDeliveries(store, olderThanSeconds = 30 * 24 * 3600, now = Math.floor(Date.now() / 1000)) {
  return store.statements.pruneDeliveries.run(now - olderThanSeconds).changes;
}
