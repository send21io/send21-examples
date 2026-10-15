import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// One SQLite file (node:sqlite, ships with Node 22.13+; no dependency).
// The webhook path follows examples/webhook-receiver-sqlite: the delivery id
// and the request update are committed in ONE transaction before the 2xx.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  fiat        TEXT NOT NULL,
  color       TEXT NOT NULL,
  pair_code   TEXT NOT NULL UNIQUE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS addresses (
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  asset    TEXT NOT NULL,
  address  TEXT NOT NULL,
  PRIMARY KEY (user_id, asset)
) STRICT;

CREATE TABLE IF NOT EXISTS contacts (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, contact_id)
) STRICT;

CREATE TABLE IF NOT EXISTS splits (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL REFERENCES users (id),
  title       TEXT,
  fiat        TEXT NOT NULL,
  total       REAL NOT NULL,
  parts       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS requests (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,            -- request | send | link
  split_id           TEXT REFERENCES splits (id),
  from_user          TEXT REFERENCES users (id), -- the payer; NULL for an open link
  to_user            TEXT NOT NULL REFERENCES users (id), -- the receiver
  created_by         TEXT NOT NULL REFERENCES users (id),
  fiat               TEXT NOT NULL,
  fiat_amount        REAL NOT NULL,
  note               TEXT,
  asset              TEXT NOT NULL,
  network            TEXT NOT NULL,
  currency           TEXT NOT NULL,
  receiver_address   TEXT NOT NULL,            -- copied from the receiver's profile at creation
  amount_base_units  INTEGER NOT NULL,
  draft_id           TEXT UNIQUE,
  payment_uri        TEXT,
  pay_url            TEXT,
  payment_request_id TEXT UNIQUE,
  options_json       TEXT,                     -- open links: the receiver's accepted assets
  idempotency_key    TEXT NOT NULL UNIQUE,
  pay_key            TEXT NOT NULL,
  status             TEXT NOT NULL,
  tx_id              TEXT,
  review_note        TEXT,
  source             TEXT NOT NULL,            -- mock | demo | api
  expires_at         INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS requests_to ON requests (to_user);
CREATE INDEX IF NOT EXISTS requests_from ON requests (from_user);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  event       TEXT NOT NULL,
  request_id  TEXT,
  outcome     TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;
`;

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT; ROLLBACK and rethrow on error. */
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}
