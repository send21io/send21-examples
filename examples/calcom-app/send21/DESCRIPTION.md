---
items:
  - icon.svg
---

{DESCRIPTION}

- Price the event in your currency (EUR, USD, SEK and 158 more). The booker picks BTC (on-chain or Lightning), USDC, USDT, EURC, SOL or ETH on the send21 pay page.
- The booking is confirmed when the signed `draft.confirmed` webhook arrives for its order, and released when the pay link expires unpaid (`payment_request.expired`).
- Your API key can only prepare pay links. No key can move funds; refunds are made by you, from your own wallet.
