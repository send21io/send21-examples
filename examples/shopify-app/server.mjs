// send21 Shopify app, Route B: order-based crypto payments without payments-partner approval.
//
// Flow: buyer checks out with the manual payment method (config.shopify.gatewayName) ->
// Shopify fires orders/create -> this app creates a send21 payment request (Idempotency-Key
// keyed on shop+order) and writes the pay link onto the order note -> the order confirmation
// email links the buyer to GET /pay/:shop/:orderId here, which redirects to the send21 pay
// page -> send21's draft.confirmed webhook arrives -> the app marks the Shopify order paid.
//
// Zero npm dependencies; secrets live in config.json (copy config.example.json) or env vars.
// State is a JSON file per concern under data/. Swap for a real DB before scaling out.
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 5922);

function loadConfig() {
  let file = {};
  try { file = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')); } catch { /* env-only is fine */ }
  const cfg = {
    appUrl: (process.env.APP_URL ?? file.appUrl ?? '').replace(/\/$/, ''),
    shopify: {
      apiKey: process.env.SHOPIFY_API_KEY ?? file.shopify?.apiKey ?? '',
      apiSecret: process.env.SHOPIFY_API_SECRET ?? file.shopify?.apiSecret ?? '',
      apiVersion: process.env.SHOPIFY_API_VERSION ?? file.shopify?.apiVersion ?? '2025-07',
      scopes: process.env.SHOPIFY_SCOPES ?? file.shopify?.scopes ?? 'read_orders,write_orders',
      gatewayName: process.env.SHOPIFY_GATEWAY_NAME ?? file.shopify?.gatewayName ?? 'Crypto (send21)'
    },
    send21: {
      apiBase: (process.env.SEND21_API_BASE ?? file.send21?.apiBase ?? 'https://send21.io').replace(/\/$/, ''),
      apiKey: process.env.SEND21_API_KEY ?? file.send21?.apiKey ?? '',
      webhookSecret: process.env.SEND21_WEBHOOK_SECRET ?? file.send21?.webhookSecret ?? '',
      expiryHours: Number(process.env.SEND21_EXPIRY_HOURS ?? file.send21?.expiryHours ?? 24),
      options: file.send21?.options ?? []
    }
  };
  for (const [k, v] of [['appUrl', cfg.appUrl], ['shopify.apiKey', cfg.shopify.apiKey],
    ['shopify.apiSecret', cfg.shopify.apiSecret], ['send21.apiKey', cfg.send21.apiKey]]) {
    if (!v) console.warn(`config: ${k} is empty. Set it in config.json or env before going live`);
  }
  if (cfg.send21.options.length === 0) console.warn('config: send21.options is empty, no currencies offered');
  return cfg;
}
const config = loadConfig();

// ---- Tiny JSON file store (MVP; single process only) ----
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
function store(name) {
  const file = join(dataDir, `${name}.json`);
  let obj;
  try { obj = JSON.parse(readFileSync(file, 'utf8')); } catch { obj = {}; }
  return {
    get: (k) => obj[k],
    set: (k, v) => { obj[k] = v; writeFileSync(file, JSON.stringify(obj, null, 2)); },
    delete: (k) => { delete obj[k]; writeFileSync(file, JSON.stringify(obj, null, 2)); }
  };
}
const shops = store('shops');   // shop domain -> { accessToken, installedAt }
const orders = store('orders'); // `${shop}:${orderId}` -> { paymentRequestId, payPath, orderGid, status }
const oauthStates = new Map();  // nonce -> shop (in-memory; OAuth roundtrip is seconds)

// ---- Helpers ----
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function safeEqual(a, b) {
  const ab = Buffer.from(a); const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// HMAC over the sorted query string, per Shopify OAuth docs.
function verifyOAuthHmac(params) {
  const { hmac, ...rest } = params;
  if (!hmac) return false;
  const message = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('&');
  const digest = createHmac('sha256', config.shopify.apiSecret).update(message).digest('hex');
  return safeEqual(digest, hmac);
}

// Base64 HMAC of the raw body, per Shopify webhook docs.
function verifyShopifyWebhook(rawBody, header) {
  if (!header) return false;
  const digest = createHmac('sha256', config.shopify.apiSecret).update(rawBody).digest('base64');
  return safeEqual(digest, header);
}

// send21 webhook: X-Send21-Signature-V2: t=<unix seconds>,v1=<hex HMAC of "<t>.<delivery id>.<raw body>">.
// Signs the time and the delivery id too, so a copied delivery cannot be replayed later.
function verifySend21Webhook(rawBody, header, deliveryId) {
  const t = /(?:^|,)t=(\d+)/.exec(header ?? '')?.[1];
  const v1 = /(?:^|,)v1=([0-9a-f]{64})/.exec(header ?? '')?.[1];
  if (!t || !v1 || !deliveryId || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const digest = createHmac('sha256', config.send21.webhookSecret)
    .update(`${t}.${deliveryId}.`).update(rawBody).digest('hex');
  return safeEqual(digest, v1);
}

async function shopifyGraphql(shop, query, variables) {
  const token = shops.get(shop)?.accessToken;
  if (!token) throw new Error(`no access token for ${shop}. Reinstall the app`);
  const res = await fetch(`https://${shop}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(`shopify graphql: ${JSON.stringify(json.errors).slice(0, 500)}`);
  return json.data;
}

async function send21(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.send21.apiKey}` };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(config.send21.apiBase + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`send21 ${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function reply(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, { 'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

// ---- OAuth install ----
function handleAuthBegin(url, res) {
  const shop = url.searchParams.get('shop') ?? '';
  if (!SHOP_RE.test(shop)) return reply(res, 400, { error: 'invalid shop parameter' });
  const state = randomBytes(16).toString('hex');
  oauthStates.set(state, shop);
  setTimeout(() => oauthStates.delete(state), 10 * 60_000).unref();
  const authorize = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(config.shopify.apiKey)}` +
    `&scope=${encodeURIComponent(config.shopify.scopes)}` +
    `&redirect_uri=${encodeURIComponent(`${config.appUrl}/auth/callback`)}` +
    `&state=${state}`;
  reply(res, 302, '', { location: authorize });
}

async function handleAuthCallback(url, res) {
  const params = Object.fromEntries(url.searchParams);
  const shop = params.shop ?? '';
  if (!SHOP_RE.test(shop) || !verifyOAuthHmac(params) || oauthStates.get(params.state) !== shop)
    return reply(res, 400, { error: 'OAuth verification failed' });
  oauthStates.delete(params.state);

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.shopify.apiKey,
      client_secret: config.shopify.apiSecret,
      code: params.code
    })
  });
  if (!tokenRes.ok) return reply(res, 502, { error: 'token exchange failed' });
  const { access_token } = await tokenRes.json();
  shops.set(shop, { accessToken: access_token, installedAt: new Date().toISOString() });

  // Subscribe to order creation (GDPR topics are configured in the Partner Dashboard).
  await shopifyGraphql(shop, `
    mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
        userErrors { message }
      }
    }`, {
    topic: 'ORDERS_CREATE',
    sub: { callbackUrl: `${config.appUrl}/webhooks/shopify/orders-create`, format: 'JSON' }
  });

  reply(res, 200, `<h1>send21 installed for ${shop}</h1>
    <p>Next: create the manual payment method named <strong>${config.shopify.gatewayName}</strong>
    (Settings &rarr; Payments &rarr; Manual payment methods) and add the pay link to your
    order confirmation email. See the app README.</p>`);
}

// ---- Shopify webhook: orders/create ----
async function handleOrderCreate(req, res) {
  const raw = await readRawBody(req);
  if (!verifyShopifyWebhook(raw, req.headers['x-shopify-hmac-sha256']))
    return reply(res, 401, { error: 'bad hmac' });
  const shop = req.headers['x-shopify-shop-domain'];
  reply(res, 200, { ok: true }); // ack fast; Shopify retries slow handlers

  try {
    const order = JSON.parse(raw.toString('utf8'));
    const gateways = order.payment_gateway_names ?? [];
    if (!gateways.some((g) => g.toLowerCase() === config.shopify.gatewayName.toLowerCase())) return;
    const key = `${shop}:${order.id}`;
    if (orders.get(key)) return; // Shopify redelivery

    const request = await send21('/api/v1/payment-requests', {
      method: 'POST',
      idempotencyKey: `shopify:${shop}:${order.id}`,
      body: {
        fiatCurrency: order.currency,
        fiatAmount: Number(order.total_price),
        orderId: `${shop}:${order.id}`,
        memo: `${order.name} at ${shop}`,
        expiryHours: config.send21.expiryHours,
        options: config.send21.options
      }
    });

    const orderGid = order.admin_graphql_api_id ?? `gid://shopify/Order/${order.id}`;
    orders.set(key, {
      paymentRequestId: request.id,
      payPath: request.payPath,
      orderGid,
      fiatCurrency: order.currency,
      fiatAmount: Number(order.total_price),
      status: 'awaiting-payment'
    });

    // Surface the pay link to the merchant on the order timeline/note.
    await shopifyGraphql(shop, `
      mutation($input: OrderInput!) {
        orderUpdate(input: $input) { userErrors { message } }
      }`, {
      input: { id: orderGid, note: `Pay with crypto: ${config.send21.apiBase}${request.payPath}` }
    });
    console.log(`order ${key}: payment request ${request.id} created`);
  } catch (e) {
    console.error('orders/create handling failed:', e.message);
  }
}

// ---- send21 webhook: mark order paid on confirmation ----
async function handleSend21Webhook(req, res) {
  const raw = await readRawBody(req);
  if (!verifySend21Webhook(raw, req.headers['x-send21-signature-v2'], req.headers['x-send21-delivery']))
    return reply(res, 401, { error: 'bad signature' });
  reply(res, 200, { ok: true });

  try {
    const event = JSON.parse(raw.toString('utf8'));
    if (event.event !== 'draft.confirmed') return;
    const orderId = event.data?.orderId; // we set this to `${shop}:${shopifyOrderId}`
    if (!orderId?.includes(':')) return;
    const mapping = orders.get(orderId);
    if (!mapping || mapping.status === 'paid') return;
    // Only the pay link this app created for the order, for the order's currency and total.
    const d = event.data;
    if (d.paymentRequestId !== mapping.paymentRequestId ||
        (mapping.fiatCurrency && (d.fiatCurrency !== mapping.fiatCurrency || Number(d.fiatAmount) !== mapping.fiatAmount))) {
      console.error(`order ${orderId}: confirmed payment does not match the order (request ${d.paymentRequestId}, ${d.fiatAmount} ${d.fiatCurrency}); not marking paid`);
      return;
    }

    const shop = orderId.slice(0, orderId.indexOf(':'));
    const data = await shopifyGraphql(shop, `
      mutation($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) { userErrors { message } }
      }`, { input: { id: mapping.orderGid } });
    const errors = data.orderMarkAsPaid?.userErrors ?? [];
    if (errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '));

    orders.set(orderId, { ...mapping, status: 'paid', txId: event.data?.txId });
    console.log(`order ${orderId}: marked paid (tx ${event.data?.txId})`);
  } catch (e) {
    console.error('send21 webhook handling failed:', e.message);
  }
}

// ---- Buyer-facing pay redirect (for the order confirmation email) ----
function handlePayRedirect(url, res) {
  const [, , shopParam, orderIdParam] = url.pathname.split('/');
  const mapping = orders.get(`${shopParam}:${orderIdParam}`);
  if (!mapping) {
    return reply(res, 404, '<h1>Payment link not ready</h1><p>Refresh in a few seconds, or contact the shop.</p>');
  }
  reply(res, 302, '', { location: `${config.send21.apiBase}${mapping.payPath}` });
}

// ---- Router ----
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, config.appUrl || `http://localhost:${port}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/auth') return handleAuthBegin(url, res);
    if (req.method === 'GET' && path === '/auth/callback') return await handleAuthCallback(url, res);
    if (req.method === 'POST' && path === '/webhooks/shopify/orders-create') return await handleOrderCreate(req, res);
    if (req.method === 'POST' && path === '/webhooks/send21') return await handleSend21Webhook(req, res);
    if (req.method === 'GET' && /^\/pay\/[^/]+\/[^/]+$/.test(path)) return handlePayRedirect(url, res);

    // Mandatory GDPR topics: verify and acknowledge (we store no customer personal data).
    if (req.method === 'POST' && /^\/webhooks\/shopify\/(customers-data-request|customers-redact|shop-redact)$/.test(path)) {
      const raw = await readRawBody(req);
      if (!verifyShopifyWebhook(raw, req.headers['x-shopify-hmac-sha256']))
        return reply(res, 401, { error: 'bad hmac' });
      if (path.endsWith('shop-redact')) {
        const shop = req.headers['x-shopify-shop-domain'];
        if (shop) shops.delete(shop);
      }
      return reply(res, 200, { ok: true });
    }

    reply(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`${req.method} ${req.url} failed:`, e);
    reply(res, 500, { error: 'internal error' });
  }
});

server.listen(port, () => {
  console.log(`send21 Shopify app on http://localhost:${port} (public URL: ${config.appUrl || 'NOT SET'})`);
});
