// Send a locally signed sample event to the running receiver, for manual testing.
// Usage: node send-sample.js [draft.confirmed|draft.amount_mismatch]
import { fileURLToPath } from "node:url";
import { sign } from "./verify.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env file, rely on the environment.
}

const secret = process.env.SEND21_WEBHOOK_SECRET;
if (!secret) {
  console.error("Set SEND21_WEBHOOK_SECRET first.");
  process.exit(1);
}
const url = `http://localhost:${process.env.PORT ?? 3000}/webhooks/send21`;
const event = process.argv[2] ?? "draft.confirmed";

// Field names follow the documented draft.confirmed example. The amount_mismatch
// sample only carries ids because its payload fields are not documented yet.
const samples = {
  "draft.confirmed": {
    event: "draft.confirmed",
    data: {
      draftId: "00000000-0000-0000-0000-000000000001",
      status: "Confirmed",
      txId: "example-txid",
      confirmations: 1,
      sentCurrency: "USDC",
      network: "Solana",
      sentAmount: "53.870000",
      fiatCurrency: "EUR",
      fiatAmount: 49.9,
      conversionRate: 0.9263,
      rateSource: "coinbase",
      orderId: "shop-order-1042",
    },
  },
  "draft.amount_mismatch": {
    event: "draft.amount_mismatch",
    data: { draftId: "00000000-0000-0000-0000-000000000002", orderId: "shop-order-1043" },
  },
};
if (!samples[event]) {
  console.error(`Unknown sample ${event}. Use one of: ${Object.keys(samples).join(", ")}`);
  process.exit(1);
}

const body = JSON.stringify(samples[event]);
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-send21-signature": sign(body, secret) },
  body,
});
console.log(res.status, await res.text());
