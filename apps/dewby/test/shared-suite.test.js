// The whole send21-pair test suite (server-side receiver addresses, idempotency, V2 webhook
// signatures, SQLite dedupe, mismatch handling, pairing, push) run against dewby's server wrapper.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pairDir = fileURLToPath(new URL("../../send21-pair/", import.meta.url));
const dewbyServer = fileURLToPath(new URL("../server/app.js", import.meta.url));

test("every send21-pair security and flow test passes on dewby's server", () => {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/**/*.test.js"], {
    cwd: pairDir, env: { ...process.env, APP_SERVER_MODULE: dewbyServer, NODE_TEST_CONTEXT: undefined }, encoding: "utf8", timeout: 120_000,
  });
  const n = (k) => Number(r.stdout.match(new RegExp(`^# ${k} (\\d+)`, "m"))?.[1] ?? NaN);
  assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-2000));
  assert.equal(n("fail"), 0);
  assert.ok(n("pass") >= 52, `expected the full suite, got ${n("pass")} passing`);
});
