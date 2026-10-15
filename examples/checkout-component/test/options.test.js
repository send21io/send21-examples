import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOptions } from "../lib/options.js";

test("parses Currency:Network:Address[:Method] and canonicalizes API values", () => {
  assert.deepEqual(parseOptions("usdt:solana:SoLAddr, Usdt:Ethereum:0xabc, btc:mainnet:me@wallet.com:lightning"), [
    { currency: "Usdt", network: "Solana", address: "SoLAddr" },
    { currency: "Usdt", network: "Ethereum", address: "0xabc" },
    { currency: "Btc", network: "Mainnet", address: "me@wallet.com", method: "Lightning" },
  ]);
});

test("USDT only on Solana and Ethereum; unknown networks refused", () => {
  assert.throws(() => parseOptions("Usdt:Polygon:0xabc"), /not offered on Polygon/);
  assert.throws(() => parseOptions("Usdt:Arbitrum:0xabc"), /not offered on Arbitrum/);
  assert.throws(() => parseOptions("Usdt:Tron:Txyz"), /unsupported network/);
  assert.throws(() => parseOptions("Usdc:Solana:"), /address is missing/);
  assert.throws(() => parseOptions("Eth:Ethereum:0xabc:Lightning"), /Lightning is only/);
});
