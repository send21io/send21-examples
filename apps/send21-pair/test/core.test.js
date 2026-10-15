import assert from "node:assert/strict";
import { test } from "node:test";
import { canMove, decodeCard, encodeCard, fiatForLocale, formatUnits, mockBaseUnits, paymentUri, pickAsset, splitAmount, validAddress } from "../web/lib/core.js";

test("smart default: cheapest the receiver accepts, EURC first for EUR", () => {
  const all = ["btc", "usdc-eth", "usdc-base", "usdc-sol", "eurc-sol", "eth-base"];
  assert.equal(pickAsset(all, "SEK", "mock"), "usdc-sol");
  assert.equal(pickAsset(all, "EUR", "mock"), "eurc-sol");
  assert.equal(pickAsset(["btc", "usdc-eth"], "USD", "mock"), "btc");
  assert.equal(pickAsset(["usdc-eth", "eurc-base"], "EUR", "mock"), "eurc-base");
  // Lightning is first, but only on live networks (no Lightning testnet in the send21 demo).
  assert.equal(pickAsset(["btc-ln", "usdc-sol"], "USD", "api"), "btc-ln");
  assert.equal(pickAsset(["btc-ln", "usdc-sol"], "USD", "mock"), "usdc-sol");
  assert.equal(pickAsset([], "USD", "mock"), null);
});

test("deep links have exactly the format send21's testnet demo returns", () => {
  // Fixtures: paymentUri values returned by POST https://send21.io/api/v1/demo/drafts
  assert.equal(paymentUri({ assetId: "usdc-sol", address: "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ", baseUnits: 100006 }),
    "solana:HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ?amount=0.100006&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  assert.equal(paymentUri({ assetId: "sol", address: "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ", baseUnits: 10463225 }),
    "solana:HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ?amount=0.010463225");
  assert.equal(paymentUri({ assetId: "usdc-base", address: "0x54d4ddfD8A8C582Ae55450c573617D5bccF860F8", baseUnits: 107830 }),
    "ethereum:0x036CbD53842c5426634e7929541eC2318f3dCF7e@84532/transfer?address=0x54d4ddfD8A8C582Ae55450c573617D5bccF860F8&uint256=107830");
  assert.equal(paymentUri({ assetId: "eth-base", address: "0x54d4ddfD8A8C582Ae55450c573617D5bccF860F8", baseUnits: 103432 }),
    "ethereum:0x54d4ddfD8A8C582Ae55450c573617D5bccF860F8@84532?value=103432000000000");
  assert.equal(paymentUri({ assetId: "btc", address: "tb1qgpjc5kgwm5ktzfl78z3499p4xqu5vsy7zuk8e7", baseUnits: 5400, message: "send21 testnet demo" }),
    "bitcoin:tb1qgpjc5kgwm5ktzfl78z3499p4xqu5vsy7zuk8e7?amount=0.00005400&message=send21%20testnet%20demo");
});

test("amount math is exact", () => {
  assert.equal(formatUnits(1234500, 6), "1.2345");
  assert.equal(formatUnits(5400, 8, { trim: false }), "0.00005400");
  assert.equal(formatUnits(0, 6), "0");
  assert.equal(mockBaseUnits(10.6, "SEK", "usdc-sol"), 1_000_000);
  const shares = splitAmount(100, 3);
  assert.deepEqual(shares, [33.34, 33.33, 33.33]);
  assert.equal(Math.round(shares.reduce((a, b) => a + b) * 100), 10000);
  assert.equal(fiatForLocale("sv-SE"), "SEK");
  assert.equal(fiatForLocale("de-DE"), "EUR");
  assert.equal(fiatForLocale("en"), "USD");
});

test("status never moves backwards", () => {
  assert.equal(canMove("awaiting", "seen"), true);
  assert.equal(canMove("seen", "paid"), true);
  assert.equal(canMove("review", "paid"), true);
  assert.equal(canMove("paid", "seen"), false);
  assert.equal(canMove("seen", "awaiting"), false);
  assert.equal(canMove("cancelled", "paid"), false);
});

test("address checks catch typos and mainnet addresses on testnet", () => {
  assert.equal(validAddress("btc", "tb1qgpjc5kgwm5ktzfl78z3499p4xqu5vsy7zuk8e7", "mock"), true);
  assert.equal(validAddress("btc", "bc1qgpjc5kgwm5ktzfl78z3499p4xqu5vsy7zuk8e7", "mock"), false);
  assert.equal(validAddress("usdc-base", "0x54d4ddfD8A8C582Ae55450c573617D5bccF860F8"), true);
  assert.equal(validAddress("usdc-base", "0x0000000000000000000000000000000000000000"), false);
  assert.equal(validAddress("usdc-sol", "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ"), true);
  assert.equal(validAddress("usdc-sol", "not an address"), false);
});

test("link payloads round-trip with UTF-8", () => {
  const card = { v: 1, n: "Zoë 🍕", a: { "usdc-sol": "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ" } };
  const enc = encodeCard(card);
  assert.match(enc, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCard(enc), card);
});
