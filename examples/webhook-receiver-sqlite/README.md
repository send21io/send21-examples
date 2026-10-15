# webhook-receiver-sqlite

The [webhook-receiver](../webhook-receiver) with a durable delivery-id store. The `X-Send21-Delivery` id and the bookkeeping update (here: mark the order paid with its `txId` on `draft.confirmed`) are committed together in one SQLite transaction, and the receiver answers 2xx only after that commit. It uses `node:sqlite`, which ships with Node.js 22.13 and later, so there is no database server and no dependency to install. Node 22 prints an `ExperimentalWarning` for `node:sqlite`; Node 24 does not.

Why this variant exists: the in-memory store in `webhook-receiver` remembers delivery ids only while the process runs. After a restart, a delivery that is still inside the 5-minute V2 window is treated as new again. send21 dedupes on its side (one pay link is one payment, and retries reuse the same `X-Send21-Delivery` id), but your receiver needs its own check too, and that check has to survive restarts.

```sh
npm test                                   # restart, lost ack and crash tests, no network needed
SEND21_WEBHOOK_SECRET=<your secret> npm start
npm run send-sample -- draft.confirmed     # in a second terminal, posts a locally signed sample
```

The database file is `data/webhooks.db` (set `SEND21_WEBHOOK_DB` to put it elsewhere).

- `store.js`: schema and `applyDelivery`, the one transaction. Copy this pattern into your own app and database.
- `server.js`: the HTTP receiver. It reuses `verify.js` from [webhook-receiver](../webhook-receiver).
- `test/durable.test.js`: the failure tests. `test/child-server.js` runs the receiver as a separate process so the tests can kill and restart it.

## Verification

Same as the in-memory example: it verifies `X-Send21-Signature-V2: t=<timestamp>,v1=<hex>`, the HMAC-SHA256 of `"<timestamp>.<delivery id>.<raw body>"` over the exact bytes received, with a constant-time compare, and refuses deliveries more than 300 seconds old. A V2 header that is present but wrong is rejected, with no fallback to the legacy header. send21 still sends the legacy `X-Send21-Signature` (body only) for compatibility, but this variant does not accept it on its own by default (`allowLegacy: false`): it does not sign the delivery id, and the delivery id is what the store relies on. Rejected deliveries are never stored.

## The atomicity boundary

For each verified delivery the receiver does this, and nothing else touches the database:

```
BEGIN IMMEDIATE
  INSERT the delivery id (PRIMARY KEY), do nothing if it is already there
    already there?  ROLLBACK, answer 200 "duplicate", change nothing
  apply the update: order ORDER-1042 is paid, txId 5KqZ9bQ..., plus one ledger row
COMMIT
answer 200
```

In plain words: the delivery id and the change it causes are saved together, or not at all. The line that matters is `COMMIT`.

- **Crash before COMMIT** (process killed, power cut, an error while applying the update): SQLite throws the unfinished transaction away. Neither the delivery id nor the update is stored. send21 gets no 2xx and retries with the same delivery id, which now looks new and is applied once. If the error is caught, the receiver answers 500 so send21 retries.
- **Crash after COMMIT, before the answer arrives** (the ack is lost, the connection drops, the process restarts): both the delivery id and the update are on disk. send21 retries, the insert finds the delivery id, and the receiver answers 200 without changing anything.
- **Restart within the 5-minute window**: the delivery id is in the file, not in process memory, so a still-valid redelivery is recognized after any number of restarts.

So each delivery's update is applied exactly once. The receiver answers 2xx only for something already committed, and anything that was not committed is retried.

What this does not cover:

- Work outside the database, such as an email or a call to another API. It cannot be part of the SQLite transaction. Write it into a table (an outbox) inside the same transaction and do it after the commit, with its own retry and its own idempotency key.
- Your bookkeeping in a different database. Then the delivery-id table has to live in that database, in the same transaction as the update. A delivery store kept somewhere else brings the same gap back.
- Two events for the same payment with different delivery ids, for example `draft.seen` and then `draft.confirmed`. Those are different deliveries. Key your records on `orderId` and `draftId`, and never move an order backwards: a late `draft.seen` does not undo a paid order here.

Notes on the SQLite settings: `journal_mode=WAL` with `synchronous=FULL` syncs every commit to disk, so a committed delivery also survives a power cut, not only a process crash. `BEGIN IMMEDIATE` takes the write lock at the start, so two processes on the same file cannot both treat one delivery id as new. Keep delivery ids at least as long as send21 can still retry (up to 8 attempts with growing gaps); `pruneDeliveries` in `store.js` removes old ids that did not change anything, 30 days by default.

## Tests

`npm test` runs, among others:

1. Commit, then the ack is lost (the connection is closed before the 200), then the process is killed and a new one opens a new connection to the same file, then the same signed delivery is sent again inside the window. Result: 200 `duplicate`, exactly one ledger row, the order paid once.
2. The process is killed with SIGKILL inside the transaction, before COMMIT, then restarted, then the same delivery is sent again. Result: nothing was stored after the crash, the redelivery is applied, a further redelivery is a no-op, exactly one ledger row.
3. The same delivery against the in-memory `webhook-receiver` before and after a restart is handled twice. That is the limitation this variant fixes.

Also: an error before commit answers 500 and stores nothing, V2 rejections (older than 300 s, wrong signature with a valid legacy header, changed delivery id, tampered body, legacy header only), a late `draft.seen` after `draft.confirmed`, and two connections to the same file.

See the [main README](../../README.md) for the delivery headers and retry rules. Questions: info@send21.io
