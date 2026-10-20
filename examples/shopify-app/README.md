# send21 for Shopify (Route B, order-based)

This is reference code, not an App Store app. There is no send21 listing in the Shopify App
Store: each merchant creates their own custom Shopify app and runs this code as the connection
between their store and send21. Help: integration@send21.io.

Adds "pay with crypto via send21" to any Shopify store **without** payments-partner approval:
the buyer checks out with a manual payment method, gets the send21 pay link, and the app marks
the order paid when the on-chain payment confirms.

Buyer flow: checkout (manual method), then the order confirmation email with the pay link, then
the send21 pay page (QR, any of your configured currencies), then payment confirmation, then the
order is marked paid.

## Run

Node.js 18 or newer, no npm dependencies.

```
cp config.example.json config.json   # fill in every field
node server.mjs                      # or: npm start   (no npm dependencies)
```

The app must be reachable over public HTTPS (`appUrl`); put it behind your nginx/Caddy or a
tunnel (e.g. `cloudflared`) during development.

## Enable it in Shopify, step by step

1. **Partner app**: at partners.shopify.com create an app (type "Custom" for a single store,
   "Public" for the app store later). Copy the Client ID/secret into `config.json`
   (`shopify.apiKey` / `shopify.apiSecret`). Set:
   - App URL: `{appUrl}/auth`
   - Allowed redirection URL: `{appUrl}/auth/callback`
   - Mandatory compliance webhooks: `{appUrl}/webhooks/shopify/customers-data-request`,
     `.../customers-redact`, `.../shop-redact`
2. **send21 side**: create an API key with `drafts:read` + `drafts:write` (API keys page) and a
   webhook endpoint pointing to `{appUrl}/webhooks/send21` subscribed to `draft.confirmed`
   (the app verifies `X-Send21-Signature-V2` and refuses deliveries older than 5 minutes);
   put the key and the webhook secret in `config.json`, plus your receiving addresses per
   currency in `send21.options` (tip: save them as "My own, I receive here" in the address book).
   New send21 accounts only accept approved receiving addresses: approve each one in send21
   (passkey or authenticator code), or the log shows 422 `address_not_approved` and no pay link is made.
3. **Install on the store**: open `{appUrl}/auth?shop=your-store.myshopify.com` and approve.
   The app stores the access token and subscribes to `orders/create`.
4. **Manual payment method**: in the store admin open Settings, then Payments, then Manual
   payment methods, then Create custom payment method. Name it exactly the `shopify.gatewayName` from
   config (default `Crypto (send21)`). In "Additional details" write e.g.
   *"You'll receive a payment link. Your order ships once the payment confirms on-chain."*
5. **Order confirmation email**: open Settings, then Notifications, then Order confirmation, and add near the top:

   ```liquid
   {% if payment_terms == nil and gateway == 'Crypto (send21)' %}
     <p><a href="https://YOUR-APP-URL/pay/{{ shop.permanent_domain }}/{{ id }}">
       Pay now with BTC / USDC / USDT</a></p>
   {% endif %}
   ```
6. **Test**: place an order with the manual method; the app log shows the payment request id,
   the order note gets the pay link, the email link redirects to the send21 pay page. Pay on a
   test network first by using testnet addresses/options in config against your own account.

## Notes / limits (MVP)

- State is JSON files in `data/`, single process only; swap for a real DB before scaling.
- One send21 account + one currency/address config for all shops; per-merchant onboarding UI
  is the next step (each merchant brings their own send21 API key and addresses).
- Refunds are out of band (crypto): refund manually from your own wallet, then refund/cancel
  the order in Shopify admin.
- The order is marked paid only when the confirmed payment belongs to the pay link the app
  created for that order, in the order's currency and total.
- Underpayments/overpayments: send21 matches the exact amount. A different amount waits for your
  decision in send21; if you accept it there, the order is marked paid on the `draft.confirmed`
  that follows. Otherwise it stays unpaid until resolved manually.
