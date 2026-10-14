import { test } from "node:test";
import assert from "node:assert/strict";
import { send21Tools, checkOption } from "../src/index.ts";

test("rejects USDT on Polygon", () => {
  assert.match(checkOption({ currency: "Usdt", network: "Polygon", address: "x" })!, /not supported/);
  assert.equal(checkOption({ currency: "Usdc", network: "Base", address: "x" }), null);
});

test("creates a pay link with fixed receive options", async () => {
  let seen: any;
  const fakeFetch = (async (url: string, init: any) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: "3f1c0f5e-0000-4000-8000-000000000001", payPath: "/pay/abc", status: "Open", expiresAt: "2026-10-15T20:00:00Z" }), { status: 201 });
  }) as unknown as typeof fetch;
  const tools = send21Tools({ apiKey: "s21_test", fetch: fakeFetch, receiveOptions: [{ currency: "Usdc", network: "Solana", address: "OWN_ADDR" }] });
  const out: any = await tools.send21CreatePayLink.execute!(
    { fiatAmount: 25, fiatCurrency: "eur", options: [{ currency: "Usdc", network: "Solana", address: "ATTACKER" }] },
    { toolCallId: "1", messages: [] } as any,
  );
  assert.equal(out.payLink, "https://send21.io/pay/abc");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.options[0].address, "OWN_ADDR");
  assert.equal(body.fiatCurrency, "EUR");
  assert.ok(seen.init.headers["Idempotency-Key"]);
});
