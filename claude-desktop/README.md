# send21 in Claude Desktop

Connect Claude Desktop to the send21 MCP server (`https://send21.io/mcp`, Streamable HTTP) so Claude can create pay links. send21 prepares payment instructions: the payer opens the link and signs in their own wallet. send21 never holds keys or funds, never signs and never broadcasts.

Claude Desktop starts local MCP servers from `claude_desktop_config.json`, so this config uses the [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge to reach the remote server. You need Node.js (for `npx`).

## Quickstart

Auth: API key or OAuth sign-in. To sign in instead of using a key, add `https://send21.io/mcp/oauth` as a custom connector in Claude (no key, no bridge); Claude opens send21 in the browser, you sign in and approve. The steps below use an API key with a local bridge.

**1. Create an API key.** At https://send21.io/api-keys create a key with the `drafts:write` scope (add `drafts:read` to let Claude look the link up later). No key can move funds.

**2. Add the server.** Open Claude Desktop > Settings > Developer > Edit Config and merge [`claude_desktop_config.json`](claude_desktop_config.json) into the file:

```json
{
  "mcpServers": {
    "send21": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://send21.io/mcp", "--header", "Authorization:${SEND21_AUTH_HEADER}"],
      "env": {
        "SEND21_AUTH_HEADER": "Bearer s21_your_key_here"
      }
    }
  }
}
```

Replace `s21_your_key_here` with your key and restart Claude Desktop. The header is passed through an environment variable because `mcp-remote` splits arguments on spaces.

**3. Ask for a pay link.** Paste the [sample prompt](sample-prompt.md) with your own receiving addresses. Claude calls `create_payment_request` and returns a `payPath`; the pay link is `https://send21.io` + `payPath`, for example `https://send21.io/pay/<token>`. Open it: the payer picks a currency (the exchange rate locks then), scans one QR code and signs in their own wallet. Funds go straight from the payer's wallet to your address.

New send21 accounts only accept receiving addresses the owner approved. Approve yours in send21 first, or let the agent propose them (`propose_receiving_address`) and approve them signed in, with a passkey or authenticator code; see the [agent flow](../README.md#agent-flow-approved-addresses). A 422 `address_not_approved` means an address still needs approval; nothing was created.

Testing: account keys use the live networks (the test networks are for the [demo](https://send21.io/demo) only). A pay link moves no money until someone pays it, so make a small one to your own address and cancel it when you are done (`POST /api/v1/payment-requests/{id}/cancel`).

## Sample prompt

See [sample-prompt.md](sample-prompt.md). Option values come from the live `create_payment_request` schema: currency `Btc`, `Usdc`, `Usdt`, `Eurc`, `Sol` or `Eth`; network `Mainnet` (Bitcoin), `Solana`, `Ethereum`, `Base`, `Arbitrum` or `Polygon`; method `Lightning` only for `Btc` on `Mainnet`. Use only the combinations in the [supported list](../README.md#supported-currencies-and-networks): for example USDT only on Solana and Ethereum, no ETH on Polygon, nothing on BNB Chain or Tron.

## Tools

`create_payment_request`, `get_payment_request`, `create_draft`, `get_draft`, `get_draft_status`, `list_draft_quotes`, `get_transaction_template`, `submit_lightning_proof`, `list_address_book`, `propose_receiving_address`, `get_account_status`, `create_account`, `get_rate`, `get_fee_schedule`. `tools/list` and `get_fee_schedule` work without a key. Claude cannot sign or pay through send21: a human signs.

To learn when a link is paid, register a webhook (see [../n8n](../n8n) or [the webhook receiver](../examples/webhook-receiver)).

Docs: https://send21.io/docs/mcp. Questions: info@send21.io
