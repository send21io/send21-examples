#!/usr/bin/env node
// Sends a send21-style webhook delivery, signed like send21 signs it, to your n8n webhook URL.
// Use it to test the workflow before a real payment arrives. No dependencies (Node 18+).
//
//   SEND21_WEBHOOK_SECRET=... node send-signed-delivery.mjs <webhook-url> <event> <orderId> <fiatAmount> <fiatCurrency> [options]
//
// options: --delivery <id>   reuse a delivery id (a retry), --age <seconds> backdate the signature,
//          --bad-signature   sign with a wrong secret, --payment-request <id>
//
// The payload follows the documented draft.confirmed example (https://send21.io/docs/webhooks).
import crypto from 'node:crypto';

const [url, event = 'draft.confirmed', orderId = 'INV-TEST', fiatAmount = '25', fiatCurrency = 'EUR', ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const secret = process.env.SEND21_WEBHOOK_SECRET;
if (!url || !secret) {
  console.error('usage: SEND21_WEBHOOK_SECRET=... node send-signed-delivery.mjs <webhook-url> <event> <orderId> <fiatAmount> <fiatCurrency>');
  process.exit(2);
}
const deliveryId = opt('--delivery') || crypto.randomUUID();
const t = Math.floor(Date.now() / 1000) - Number(opt('--age') || 0);
const data = {
  draftId: crypto.randomUUID(),
  quoteId: crypto.randomUUID(),
  status: event === 'draft.confirmed' ? 'Confirmed' : 'AwaitingPayment',
  txId: 'TEST-' + deliveryId.slice(0, 8),
  confirmations: 1,
  sentCurrency: 'USDC',
  network: 'Solana',
  amountSats: Math.round(Number(fiatAmount) * 1.08 * 1e6),
  sentAmount: (Number(fiatAmount) * 1.08).toFixed(6),
  fiatCurrency,
  fiatAmount: Number(fiatAmount),
  conversionRate: 0.925,
  rateSource: 'coinbase',
  orderId,
  occurredAt: new Date().toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z'),
};
if (opt('--payment-request')) data.paymentRequestId = opt('--payment-request');
if (event === 'payment_request.expired') Object.assign(data, { opened: true, quoteRequested: false });
const body = JSON.stringify({ event, data });
const key = rest.includes('--bad-signature') ? 'wrong-secret' : secret;
const v1 = crypto.createHmac('sha256', key).update(`${t}.${deliveryId}.${body}`).digest('hex');
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Send21-Event': event,
    'X-Send21-Delivery': deliveryId,
    'X-Send21-Timestamp': String(t),
    'X-Send21-Signature': 'sha256=' + crypto.createHmac('sha256', key).update(body).digest('hex'),
    'X-Send21-Signature-V2': `t=${t},v1=${v1}`,
  },
  body,
});
console.log(res.status, (await res.text()).slice(0, 200), 'delivery', deliveryId);
