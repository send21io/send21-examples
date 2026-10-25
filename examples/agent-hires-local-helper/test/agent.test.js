import test from "node:test";
import assert from "node:assert/strict";
import { draftPaymentForDoneTask } from "../lib/agent.js";

const cfg = {
  helper: { label: "Your local helper", network: "Solana", currency: "Usdt", address: "HYKwDo4ZMFoTo2yCLpgeKq8quErCXu1sL8rHPgSknsv7" },
  task: { id: "t1", title: "Photo check", fiatCurrency: "EUR", fiatAmount: 3 },
  orderId: "helper-task-t1",
};

function fakeMcp({ policy = "InlineAllowed", book = [] } = {}) {
  const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "get_account_status") return { receivingAddressPolicy: policy, approvedReceivingAddresses: book.length };
      if (name === "list_address_book") return book;
      if (name === "create_payment_request") return { id: "pr1", orderId: args.orderId, status: "Open", payPath: "/pay/abc", fiatCurrency: args.fiatCurrency, fiatAmount: args.fiatAmount, options: args.options };
      throw new Error(name);
    },
  };
}

test("sends orderId with reuseOpenForOrder and the helper's stored address", async () => {
  const mcp = fakeMcp();
  const r = await draftPaymentForDoneTask(mcp, cfg);
  const create = mcp.calls.find((c) => c.name === "create_payment_request").args;
  assert.equal(create.orderId, "helper-task-t1");
  assert.equal(create.reuseOpenForOrder, true);
  assert.equal(create.options[0].address, cfg.helper.address);
  assert.equal(r.payUrl, "https://send21.io/pay/abc");
  assert.equal(r.addressCheck.match, true);
});

test("with ApprovedOnly and an unapproved address the agent stops and creates nothing", async () => {
  const mcp = fakeMcp({ policy: "ApprovedOnly" });
  const r = await draftPaymentForDoneTask(mcp, cfg);
  assert.equal(r.stopped, true);
  assert.equal(mcp.calls.some((c) => c.name === "create_payment_request"), false);
});
