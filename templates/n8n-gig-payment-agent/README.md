# send21 gig payment agent for n8n (MCP)

An importable n8n AI agent, [`send21-gig-payment-agent.n8n.json`](send21-gig-payment-agent.n8n.json), for freelancers. When a job is done you tell it in the n8n chat, for example *"Finished the logo for Acme: 6 h at 55 EUR plus 20 EUR stock photos"*. The agent:

1. works out the quote (line items and total) and asks you to confirm it;
2. reads your approved receiving addresses from send21 (`list_address_book`);
3. creates a send21 pay link with `create_payment_request` over the send21 MCP server (`https://send21.io/mcp`), with the job id as `orderId`, `reuseOpenForOrder: true` and an idempotency key, so asking twice does not bill twice;
4. gives you the link and a short message to send the client;
5. later, tells you whether the job is paid (`get_payment_request`).

Nodes: Chat Trigger, AI Agent, OpenAI Chat Model (swap in any chat model), Simple Memory, and **MCP Client Tool** limited to six send21 tools: `list_address_book`, `get_account_status`, `propose_receiving_address`, `create_payment_request`, `get_payment_request`, `get_rate`. `create_draft` (paying someone) and `create_account` are left out on purpose.

**The agent proposes, you approve.** It only uses receiving addresses you approved in the send21 app. If you give it a new address of your own, it can propose it (`propose_receiving_address`), but only you can approve it, with a passkey or authenticator code. Until then a pay link to it fails with `422 address_not_approved`. The agent never signs, sends or approves anything, and it never accepts or declines a payment with a different amount: that is your decision in send21. The client pays from their own wallet; send21 never holds keys or funds.

## Setup (3 steps)

1. **send21 key.** Create a key at https://send21.io/api-keys with `drafts:read`, `drafts:write`, `addressbook:read` and `addressbook:write`. In n8n add a *Bearer Auth* credential named `send21 API key` with that key. Import the workflow and select it on the **send21 MCP** node.
2. **Model.** Add an OpenAI credential on **OpenAI Chat Model**, or replace that node with any chat model n8n supports.
3. **Addresses.** In the send21 app, approve the addresses you get paid to (for example your Solana address for USDC and USDT, your Base address for USDC and EURC). Then click **Open chat** in n8n.

USDT works on Solana and Ethereum only, and the system prompt keeps to that.

## Notes

- To get the paid status pushed to you instead of asking, add the signed-webhook branch of the [send21 invoice agent](../n8n-invoice-agent) template (V2 signature check, 5-minute window, dedupe by `X-Send21-Delivery`).
- send21 also offers MCP sign-in at `https://send21.io/mcp/oauth` (OAuth 2.1, no key to copy). If your n8n version offers MCP OAuth2 on the MCP Client Tool node, you can point it there instead of using a key. This template was tested with the key.

Tested on n8n 2.44.6: the workflow imports and publishes. n8n's own MCP Client node connected to `https://send21.io/mcp` with the Bearer credential over HTTP Streamable and ran `get_account_status` and `get_rate`. All six selected tool names are among the 14 the server lists. A full chat run needs an LLM key and was not part of the test.

Docs: https://send21.io/docs/mcp · Questions: info@send21.io
