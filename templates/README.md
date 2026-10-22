# Agent templates

Ready-made agents that do one real job with send21, for the tools builders already use. Each folder has the importable file, a README with a 3-step setup, and a way to test it before a real payment.

| Template | Tool | Job |
|---|---|---|
| [n8n-invoice-agent](n8n-invoice-agent) | n8n workflow (JSON) | Invoice from a form or API call → send21 pay link → emailed to the client → signed `draft.confirmed` webhook → invoice marked paid, receipt sent |
| [n8n-gig-payment-agent](n8n-gig-payment-agent) | n8n AI Agent + MCP Client Tool | Chat with it after a job: it quotes, waits for your OK, creates the pay link over the send21 MCP server and checks whether it was paid |
| [dify-gig-payment-agent](dify-gig-payment-agent) | Dify workflow (DSL yml) | Finished job → quote computed in code → send21 pay link → message for the client; callable as an API |
| [langgraph-invoice-agent](langgraph-invoice-agent) | LangGraph (Python) | Invoice → pay link over MCP → email → `interrupt()` until the signed webhook resumes it → paid |

All of them follow the same rules:

- **Agent proposes, human approves.** Pay links only go to receiving addresses the owner approved in the send21 app (passkey or authenticator code). Any other address returns `422 address_not_approved`. An agent can propose an address, but it can never approve one, sign, or send money.
- **The payer signs in their own wallet.** send21 prepares the pay link and never holds keys or funds.
- **Webhooks are verified and deduplicated by the receiver.** Check `X-Send21-Signature-V2` over the raw body, refuse deliveries more than 5 minutes old, and ignore an `X-Send21-Delivery` id you already handled (send21 retries with the same id).
- **Amount mismatches are the owner's decision**, never the agent's.
- **One link per order.** `orderId` + `reuseOpenForOrder: true` + an `Idempotency-Key`.

Currencies: BTC (on-chain and Lightning), USDC, USDT (Solana and Ethereum only), EURC, SOL and ETH, priced in any of 161 fiat currencies. See https://send21.io/docs/currencies.
