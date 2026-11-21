import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultIdempotencyKey, draftBody, statusComment } from "../src/create-draft.js";

describe("draftBody", () => {
  it("builds a fiat-priced single-output draft", () => {
    assert.deepEqual(
      draftBody({
        receiverAddress: "YourSolanaAddress",
        network: "Solana",
        currency: "Usdc",
        fiatCurrency: "EUR",
        fiatAmount: "25",
        expiryHours: "24",
      }),
      {
        receiverAddress: "YourSolanaAddress",
        network: "Solana",
        currency: "Usdc",
        paymentMethod: "MultiOutput",
        fiatCurrency: "EUR",
        fiatAmount: 25,
        expiryHours: 24,
        singleOutput: true,
      }
    );
  });

  it("accepts base units and singleOutput=false", () => {
    const body = draftBody({
      receiverAddress: "bc1qreceiver",
      network: "Mainnet",
      currency: "Btc",
      paymentMethod: "MultiOutput",
      amountSats: "100000",
      singleOutput: "false",
    });
    assert.equal(body.amountSats, 100000);
    assert.equal(body.singleOutput, false);
    assert.equal(body.fiatAmount, undefined);
  });

  it("requires an amount and a receiver", () => {
    assert.throws(() => draftBody({ network: "Solana", currency: "Usdc" }), /receiver-address/);
    assert.throws(
      () => draftBody({ receiverAddress: "Abc", network: "Solana", currency: "Usdc" }),
      /fiat-amount or amount-sats/
    );
  });
});

describe("defaultIdempotencyKey", () => {
  it("is stable for the same repo and issue", () => {
    assert.equal(
      defaultIdempotencyKey({ owner: "send21io", repo: "send21-examples", issueNumber: 14 }),
      "send21-draft-send21io/send21-examples#14"
    );
  });
});

describe("statusComment", () => {
  it("says a person signs from their own wallet and never claims spend control", () => {
    const text = statusComment({
      draft: {
        id: "3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c",
        status: "AwaitingPayment",
        receiverAddress: "YourSolanaAddress",
        network: "Solana",
        currency: "Usdc",
        fiatAmount: 25,
        fiatCurrency: "EUR",
        paymentUri: "solana:YourSolanaAddress?amount=25",
        expiresAt: "2026-11-22T19:00:00.000Z",
      },
      status: { status: "AwaitingPayment" },
      repository: "send21io/send21-examples",
    });
    assert.match(text, /signs and sends this payment from their own wallet/);
    assert.match(text, /no API key can move funds/);
    assert.match(text, /3f6c2a9e-5d1b-4c8e-9a7f-2b4d6e8f0a1c/);
    assert.match(text, /AwaitingPayment/);
    assert.doesNotMatch(text, /spend limit|gateway|processor|x402/i);
  });
});
