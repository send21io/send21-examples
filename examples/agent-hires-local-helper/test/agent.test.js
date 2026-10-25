import test from "node:test";
import assert from "node:assert/strict";
import { draftPaymentForDoneTask, confirmsDraft } from "../lib/agent.js";

const address = "HYKwDo4ZMFoTo2yCLpgeKq8quErCXu1sL8rHPgSknsv7";
const cfg = {
  helper: { label: "Your local helper", network: "Solana", currency: "Usdt", address },
  task: { id: "t1", title: "Photo check", fiatCurrency: "EUR", fiatAmount: 3 },
  idempotencyKey: "helper-task-t1",
};
const future = () => new Date(Date.now() + 3600e3).toISOString();

function fakes({ policy = "InlineAllowed", book = [], draftStatus = "AwaitingPayment" } = {}) {
  const calls = [];
  const draft = (status) => ({ id: "d1", status, network: "Solana", currency: "Usdt", receiverAddress: address, amountBaseUnits: 3369821, fiatCurrency: "EUR", fiatAmount: 3, paymentUri: `solana:${address}?amount=3.369821`, expiresAt: future(), quote: { lockedUntil: future() } });
  const mcp = {
    async callTool(name) {
      calls.push(name);
      if (name === "get_account_status") return { receivingAddressPolicy: policy };
      if (name === "list_address_book") return book;
      throw new Error(name);
    },
  };
  const api = {
    async post(path, body, opts) {
      calls.push({ path, body, opts });
      return path.endsWith("/requote") ? draft("AwaitingPayment") : draft(draftStatus);
    },
  };
  return { mcp, api, calls };
}

test("creates a single-output draft to the saved address with an Idempotency-Key from the task id", async () => {
  const f = fakes();
  const r = await draftPaymentForDoneTask(f, cfg);
  const create = f.calls.find((c) => c.path === "/drafts");
  assert.equal(create.opts.idempotencyKey, "helper-task-t1");
  assert.equal(create.body.receiverAddress, address);
  assert.equal(create.body.singleOutput, true);
  assert.equal("reuseOpenForOrder" in create.body, false);
  assert.equal(r.draft.id, "d1");
  assert.equal(r.addressCheck.match, true);
  assert.equal(r.approvedInSend21, false);
});

test("with ApprovedOnly and an unapproved address the agent stops and creates nothing", async () => {
  const f = fakes({ policy: "ApprovedOnly" });
  const r = await draftPaymentForDoneTask(f, cfg);
  assert.equal(r.stopped, true);
  assert.equal(f.calls.some((c) => c.path === "/drafts"), false);
});

test("with ApprovedOnly and an approved address it drafts", async () => {
  const f = fakes({ policy: "ApprovedOnly", book: [{ address, network: "Solana", verifiedAt: "2026-10-01T00:00:00.000Z" }] });
  const r = await draftPaymentForDoneTask(f, cfg);
  assert.equal(r.stopped, false);
  assert.equal(r.approvedInSend21, true);
});

test("an expired price lock within the draft's life is re-quoted, not duplicated", async () => {
  const f = fakes({ draftStatus: "Expired" });
  const r = await draftPaymentForDoneTask(f, cfg);
  assert.deepEqual(f.calls.filter((c) => c.path).map((c) => c.path), ["/drafts", "/drafts/d1/requote"]);
  assert.equal(r.draft.status, "AwaitingPayment");
});

test("a cancelled draft for the task stops instead of drafting again", async () => {
  const r = await draftPaymentForDoneTask(fakes({ draftStatus: "Cancelled" }), cfg);
  assert.equal(r.stopped, true);
});

test("draft.confirmed matches on draftId, asset, network and amount", () => {
  const draft = { id: "d1", currency: "Usdt", network: "Solana", amountBaseUnits: 3369821 };
  const data = { draftId: "d1", sentCurrency: "USDT", network: "Solana", amountSats: 3369821 };
  assert.equal(confirmsDraft("draft.confirmed", data, draft), true);
  assert.equal(confirmsDraft("draft.confirmed", { ...data, draftId: "other" }, draft), false);
  assert.equal(confirmsDraft("draft.confirmed", { ...data, network: "Ethereum" }, draft), false);
  assert.equal(confirmsDraft("draft.confirmed", { ...data, amountSats: 1 }, draft), false);
  assert.equal(confirmsDraft("draft.seen", data, draft), false);
});
