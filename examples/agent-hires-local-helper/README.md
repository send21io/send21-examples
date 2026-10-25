# Agent hires a local helper

You run your own agent. It asks a local helper you already know and trust for a small physical task, for example a photo check of a delivery. When the task is reported done, the agent asks [send21](https://send21.io/) for a pay link to the helper's saved receiving address. You review it and sign in your own wallet.

**send21 drafts the payment and a human signs it, nothing more.** There is no escrow, no dispute handling and no check of the work itself. This is a self-built setup for paying your own trusted helpers; it does not find helpers for you.

send21: crypto pay links and API for people and AI agents. The agent's key can create and read pay links, but no key can move funds. send21 never holds keys, never signs and never broadcasts.

## What you see

| 1. Task card | 2. Owner review | 3. Paid |
|---|---|---|
| The task, where, the agreed amount, and the helper's receiving address in groups of four. One button: **Task done**. | **Matches the helper address you saved** (or **Pays your helper's pre-approved address** when it is an owner-verified entry in your send21 address book), the amount, the full address, what the agent did, and one button: **Open pay link to sign in your wallet**. | After the signed `draft.confirmed` webhook (or the pay link turning `Completed`). |

The steps read *Draft created → Waiting for your signature → Paid*.

<p><img src="docs/1-task-card-desktop.png" alt="Helper task card with the Task done button" width="49%"> <img src="docs/3-owner-review-desktop.png" alt="Owner review with the Open pay link to sign in your wallet button" width="49%"></p>

## How it works

The agent (here `lib/agent.js`, run by the server or by `npm run agent`) talks to the send21 MCP server at `https://send21.io/mcp` with a scoped key:

1. `get_account_status`: reads the account's receiving-address policy.
2. `list_address_book`: checks whether the helper's address is one you approved in send21.
3. `create_payment_request`: a pay link priced in your currency (`fiatCurrency`, `fiatAmount`), with one option, the helper's address and asset (for example USDT on Solana or USDC on Polygon), and `orderId: "helper-task-<task id>"` with `reuseOpenForOrder: true`. If the agent is asked again for the same task (a retry, a duplicate "done" message), send21 returns the open link for that `orderId` instead of creating a second one. `npm run agent` shows this: it asks twice and gets the same id.
4. The owner opens `https://send21.io/pay/...`, checks the address in their own wallet and signs.
5. Optional: a webhook endpoint (`POST /api/v1/webhooks`, scope `webhooks:manage`) receives `draft.confirmed`. The server checks `X-Send21-Signature-V2`, refuses deliveries older than 5 minutes, ignores a delivery id it already handled (retries reuse `X-Send21-Delivery`), and marks the task paid only if `orderId`, asset, network and price match.

### The helper's address

The helper gives you their receiving address once; you save it in `helper.json`. The agent reads it from there and cannot change it.

On accounts with the receiving-address policy `ApprovedOnly` (the default for new accounts), API keys can only use addresses the owner approved in the send21 app with a passkey or an authenticator code. The agent cannot approve one. If the helper's address is not approved, the agent stops and tells you, and creates nothing. Note that send21 describes pay links as going to the owner's own approved receiving addresses and drafts as paying any approved address; check that your account accepts the helper's address for a pay link before you rely on it.

## Run it

Requires Node.js 20 or newer. No npm dependencies.

```bash
cd examples/agent-hires-local-helper
cp .env.example .env        # add a scoped key from https://send21.io/api-keys
# put your helper's receiving address, network and currency in helper.json
npm start                   # web UI on http://localhost:3022
```

The agent alone, in the terminal:

```bash
npm run agent                    # task done -> pay link, then the same request again
npm run agent -- --cancel <id>   # cancel a test pay link
```

Tests (no key, no network): `npm test`.

### About test networks

send21's [testnet demo](https://send21.io/demo) runs in the browser with no account. Account API keys use the live networks. A pay link moves no money until someone pays it, so test with a small amount to your own address and cancel the link afterwards.

### See the Paid screen without paying

Set `LOCAL_TEST_WEBHOOK_SECRET` in `.env`, start the server, mark the task done, then run `npm run local-paid`. It signs a test `draft.confirmed` delivery locally, posts it twice (the second time it is ignored as already handled), and the UI shows **Paid** labelled **Local test webhook**, so it is never mistaken for a real payment.

### Use it from your own agent

Any MCP client can make the same calls. Add send21 to your client:

```json
{ "mcpServers": { "send21": { "url": "https://send21.io/mcp", "headers": { "Authorization": "Bearer s21_YOUR_KEY" } } } }
```

and give the agent a rule like: *When a helper task is reported done, call `create_payment_request` with the helper's saved address, `orderId` = the task id and `reuseOpenForOrder: true`, then give me the pay link. Never sign or send payments.*

## Files

| File | What it is |
|---|---|
| `helper.json` | The helper's receiving address and the task |
| `lib/mcp.js` | A minimal MCP client (Streamable HTTP) |
| `lib/agent.js` | What the agent does when the task is done |
| `lib/webhook.js` | `X-Send21-Signature-V2` check |
| `server.js`, `public/` | Web UI (plain HTML, CSS and JS); the key stays on the server |
| `agent-cli.js` | The agent flow in the terminal |

Questions: info@send21.io
