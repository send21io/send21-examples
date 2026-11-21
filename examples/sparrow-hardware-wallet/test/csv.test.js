import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { payToManyCsvFrom, satsToBtc, summarizeOutputs, parseArgs } from "../fetch-tx-template.js";

describe("satsToBtc", () => {
  it("formats 8 decimal BTC amounts", () => {
    assert.equal(satsToBtc(100000000), "1.00000000");
    assert.equal(satsToBtc(546), "0.00000546");
    assert.equal(satsToBtc(0), "0.00000000");
  });
});

describe("payToManyCsvFrom", () => {
  it("uses the API payToManyCsv when present", () => {
    const csv = payToManyCsvFrom({ payToManyCsv: "bc1qabc,0.01000000\nbc1qfee,0.00002000" });
    assert.equal(csv, "bc1qabc,0.01000000\nbc1qfee,0.00002000\n");
  });

  it("builds address,amount rows from outputs", () => {
    const csv = payToManyCsvFrom({
      outputs: [
        { address: "bc1qreceiver", amountSats: 1_000_000, purpose: "payment" },
        { address: "bc1qfee", amountBtc: "0.00002000", purpose: "fee" },
      ],
    });
    assert.equal(csv, "bc1qreceiver,0.01000000\nbc1qfee,0.00002000\n");
  });
});

describe("summarizeOutputs", () => {
  it("lists purpose, address and BTC amount", () => {
    const rows = summarizeOutputs({
      outputs: [{ address: "bc1qreceiver", amountSats: 50_000, purpose: "payment" }],
    });
    assert.deepEqual(rows[0], {
      address: "bc1qreceiver",
      amountBtc: "0.00050000",
      amountSats: 50_000,
      purpose: "payment",
    });
  });
});

describe("parseArgs", () => {
  it("reads --draft and --out", () => {
    const args = parseArgs(["--draft", "abc", "--out", "out.csv"], {});
    assert.equal(args.draftId, "abc");
    assert.equal(args.out, "out.csv");
  });
});
