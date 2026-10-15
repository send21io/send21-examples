import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sign, signV2 } from "../../webhook-receiver/verify.js";
import { createWebhookServer as createInMemoryServer } from "../../webhook-receiver/server.js";
import { confirmedBody as confirmed } from "../../webhook-receiver/samples.js";
import { applyDelivery, openStore } from "../store.js";
import { createWebhookServer } from "../server.js";

const secret = randomBytes(32).toString("hex");
const childScript = fileURLToPath(new URL("./child-server.js", import.meta.url));
const ORDER = JSON.parse(confirmed).data.orderId; // ORDER-1042
const TX = JSON.parse(confirmed).data.txId;

const tempDb = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "send21-webhook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "webhooks.db");
};

/** One signed delivery. The same object is sent again for a redelivery: same bytes, same headers. */
const signedDelivery = (body = confirmed, { delivery = randomUUID(), timestamp = Math.floor(Date.now() / 1000) } = {}) => ({
  body,
  headers: {
    "content-type": "application/json",
    "x-send21-event": JSON.parse(body).event,
    "x-send21-delivery": delivery,
    "x-send21-timestamp": String(timestamp),
    "x-send21-signature-v2": signV2(body, delivery, timestamp, secret),
    "x-send21-signature": sign(body, secret), // legacy, still sent
  },
});

const post = (port, { body, headers }) => fetch(`http://127.0.0.1:${port}/webhooks/send21`, { method: "POST", headers, body });

/** What is durably on disk, read through a brand-new connection. */
const durableState = (file) => {
  const store = openStore(file);
  try {
    // node:sqlite returns rows with a null prototype; copy them into plain objects.
    const one = (sql, ...args) => {
      const row = store.db.prepare(sql).get(...args);
      return row && { ...row };
    };
    return {
      deliveries: one("SELECT count(*) AS n FROM deliveries").n,
      ledgerRows: one("SELECT count(*) AS n FROM ledger WHERE order_id = ?", ORDER).n,
      order: one("SELECT status, tx_id FROM orders WHERE order_id = ?", ORDER) ?? null,
    };
  } finally {
    store.close();
  }
};

/** Start the receiver as a separate process on `file`. */
const startProcess = (t, file, fault = "") =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", childScript], {
      env: { ...process.env, SEND21_WEBHOOK_DB: file, SEND21_WEBHOOK_SECRET: secret, FAULT: fault },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
    t.after(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"));
    child.once("error", reject);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/ready (\d+)/);
      if (m) resolve({ port: Number(m[1]), exited, kill: () => (child.kill("SIGKILL"), exited) });
    });
    exited.then(({ code, signal }) => reject(new Error(`child exited early (${code ?? signal})`)));
  });

test("commit, ack lost, process restart, redelivery within the window: exactly one durable update", async (t) => {
  const file = tempDb(t);
  const delivery = signedDelivery();

  // Process 1 commits the delivery and the order update, then the connection
  // drops before the 200 is written. send21 sees no answer and will retry.
  const first = await startProcess(t, file, "drop-ack");
  await assert.rejects(post(first.port, delivery), "the ack never arrives");
  assert.deepEqual(durableState(file), { deliveries: 1, ledgerRows: 1, order: { status: "paid", tx_id: TX } }, "committed before the ack");

  // Restart: the old process is gone, a new one opens a new connection to the same file.
  await first.kill();
  const second = await startProcess(t, file);

  // Redelivery of the same signed delivery, still inside the 300 s window.
  const res = await post(second.port, delivery);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "duplicate" });

  // And once more, for good measure.
  assert.deepEqual(await (await post(second.port, delivery)).json(), { ok: true, outcome: "duplicate" });

  assert.deepEqual(durableState(file), { deliveries: 1, ledgerRows: 1, order: { status: "paid", tx_id: TX } }, "exactly one durable update");
});

test("crash before commit, restart, redelivery: rolled back, then applied exactly once", async (t) => {
  const file = tempDb(t);
  const delivery = signedDelivery();

  // Process 1 inserts the delivery id and marks the order paid inside the
  // transaction, then is killed with SIGKILL before COMMIT. No cleanup code runs.
  const first = await startProcess(t, file, "crash-before-commit");
  await assert.rejects(post(first.port, delivery), "the process died, no answer");
  assert.equal((await first.exited).signal, "SIGKILL");

  // Nothing of the unfinished transaction is visible to a new connection.
  assert.deepEqual(durableState(file), { deliveries: 0, ledgerRows: 0, order: null }, "rolled back");

  // Restart and redeliver the same signed delivery: it is new, so it is applied now.
  const second = await startProcess(t, file);
  let res = await post(second.port, delivery);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });

  // Any further redelivery is a no-op.
  res = await post(second.port, delivery);
  assert.deepEqual(await res.json(), { ok: true, outcome: "duplicate" });

  assert.deepEqual(durableState(file), { deliveries: 1, ledgerRows: 1, order: { status: "paid", tx_id: TX } }, "exactly one durable update");
});

test("contrast: the in-memory store of ../webhook-receiver handles the same delivery again after a restart", async (t) => {
  // This is the reported limitation that the durable variant fixes.
  const delivery = signedDelivery();
  const outcomes = [];
  for (let restart = 0; restart < 2; restart++) {
    const server = createInMemoryServer({ secret, log: () => {} }); // fresh process memory
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    outcomes.push((await (await post(server.address().port, delivery)).json()).outcome);
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(outcomes, ["order_paid", "order_paid"]);
});

const inProcessServer = async (t, file, options = {}) => {
  const store = openStore(file);
  const server = createWebhookServer({ secret, store, log: () => {}, ...options });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
  });
  return server.address().port;
};

test("an error before commit answers 500, stores nothing, and the retry applies the update once", async (t) => {
  const file = tempDb(t);
  let fail = true;
  const port = await inProcessServer(t, file, {
    hooks: {
      beforeCommit: () => {
        if (fail) throw new Error("simulated failure before COMMIT");
      },
    },
  });
  const delivery = signedDelivery();
  let res = await post(port, delivery);
  assert.equal(res.status, 500, "not 2xx, so send21 retries");
  assert.deepEqual(durableState(file), { deliveries: 0, ledgerRows: 0, order: null });

  fail = false;
  res = await post(port, delivery);
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });
  res = await post(port, delivery);
  assert.deepEqual(await res.json(), { ok: true, outcome: "duplicate" });
  assert.equal(durableState(file).ledgerRows, 1);
});

test("V2 verification: 300 s window, signed delivery id, no legacy fallback; rejected deliveries are not stored", async (t) => {
  const file = tempDb(t);
  const port = await inProcessServer(t, file);
  const now = Math.floor(Date.now() / 1000);

  // Older than 300 s: refused.
  let res = await post(port, signedDelivery(confirmed, { timestamp: now - 301 }));
  assert.equal(res.status, 401);

  // An invalid V2 header with a valid legacy header: refused, no fallback.
  const bad = signedDelivery();
  bad.headers["x-send21-signature-v2"] = bad.headers["x-send21-signature-v2"].replace(/v1=./, (m) => (m.endsWith("0") ? "v1=1" : "v1=0"));
  res = await post(port, bad);
  assert.equal(res.status, 401);

  // The delivery id is signed: changing it breaks the signature.
  const moved = signedDelivery();
  moved.headers["x-send21-delivery"] = randomUUID();
  res = await post(port, moved);
  assert.equal(res.status, 401);

  // Legacy header only: refused by default in this variant (it does not sign the delivery id).
  const legacyOnly = signedDelivery();
  delete legacyOnly.headers["x-send21-signature-v2"];
  res = await post(port, legacyOnly);
  assert.equal(res.status, 401);

  // A tampered body.
  const tampered = signedDelivery();
  tampered.body = tampered.body.replace('"sentAmount":"50.000000"', '"sentAmount":"0.000001"');
  res = await post(port, tampered);
  assert.equal(res.status, 401);

  assert.deepEqual(durableState(file), { deliveries: 0, ledgerRows: 0, order: null }, "nothing stored for rejected deliveries");

  // Within the window (299 s old) it is accepted.
  res = await post(port, signedDelivery(confirmed, { timestamp: now - 299 }));
  assert.deepEqual(await res.json(), { ok: true, outcome: "order_paid" });
});

test("a late draft.seen never moves a paid order back; draft.created is recorded and ignored", async (t) => {
  const file = tempDb(t);
  const port = await inProcessServer(t, file);
  const data = JSON.parse(confirmed).data;
  const created = JSON.stringify({ event: "draft.created", data: { ...data, status: "AwaitingPayment" } });
  const seen = JSON.stringify({ event: "draft.seen", data: { ...data, status: "Seen" } });

  assert.equal((await (await post(port, signedDelivery(created))).json()).outcome, "ignored");
  assert.equal((await (await post(port, signedDelivery(seen))).json()).outcome, "payment_seen");
  assert.deepEqual(durableState(file).order, { status: "payment_seen", tx_id: TX });
  assert.equal((await (await post(port, signedDelivery(confirmed))).json()).outcome, "order_paid");
  assert.equal((await (await post(port, signedDelivery(seen))).json()).outcome, "payment_seen");
  assert.deepEqual(durableState(file), { deliveries: 4, ledgerRows: 1, order: { status: "paid", tx_id: TX } });
});

test("two connections to the same file: the second sees the committed delivery id", (t) => {
  const file = tempDb(t);
  const a = openStore(file);
  const b = openStore(file);
  t.after(() => (a.close(), b.close()));
  const payload = JSON.parse(confirmed);
  const id = randomUUID();
  assert.deepEqual(applyDelivery(a, id, payload), { outcome: "order_paid", duplicate: false });
  assert.deepEqual(applyDelivery(b, id, payload), { outcome: "duplicate", duplicate: true });
  assert.equal(durableState(file).ledgerRows, 1);
});
