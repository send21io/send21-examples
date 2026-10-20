# send21 in Cursor

Connect Cursor to the send21 MCP server (`https://send21.io/mcp`, Streamable HTTP) so the agent can create pay links. send21 prepares payment instructions: the payer opens the link and signs in their own wallet. send21 never holds keys or funds, never signs and never broadcasts.

## Quickstart

**1. Create an API key.** At https://send21.io/api-keys create a key with the `drafts:write` scope (add `drafts:read` to look links up later). No key can move funds. Export it in the shell Cursor starts from:

```sh
export SEND21_API_KEY=s21_your_key_here
```

**2. Add the server.** Copy [`.cursor/mcp.json`](.cursor/mcp.json) into your project (or merge it into `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "send21": {
      "url": "https://send21.io/mcp",
      "headers": {
        "Authorization": "Bearer ${env:SEND21_API_KEY}"
      }
    }
  }
}
```

Restart Cursor and check that `send21` shows its tools under Settings > MCP.

**3. Ask for a pay link.** In Agent chat, paste the [sample prompt](sample-prompt.md) with your own receiving addresses. The agent calls `create_payment_request` and returns a `payPath`; the pay link is `https://send21.io` + `payPath`, for example `https://send21.io/pay/<token>`. The payer opens it, picks a currency (the rate locks then), scans one QR code and signs in their own wallet.

New send21 accounts only accept receiving addresses the owner approved. Approve yours in send21 first, or let the agent propose them (`propose_receiving_address`) and approve them signed in, with a passkey or authenticator code; see the [agent flow](../README.md#agent-flow-approved-addresses). A 422 `address_not_approved` means an address still needs approval; nothing was created.

Testing: account keys use the live networks (the test networks are for the [demo](https://send21.io/demo) only). A pay link moves no money until someone pays it, so make a small one to your own address and cancel it when you are done (`POST /api/v1/payment-requests/{id}/cancel`).

## Sample prompt

See [sample-prompt.md](sample-prompt.md). Option values: currency `Btc`, `Usdc`, `Usdt`, `Eurc`, `Sol` or `Eth`; network `Mainnet` (Bitcoin), `Solana`, `Ethereum`, `Base`, `Arbitrum` or `Polygon`; method `Lightning` only for `Btc` on `Mainnet`. Use only the [supported combinations](../README.md#supported-currencies-and-networks): USDT only on Solana and Ethereum, no ETH on Polygon, nothing on BNB Chain or Tron.

For a scripted version of the same call, see [examples/mcp-payment-request](../examples/mcp-payment-request).

Docs: https://send21.io/docs/mcp. Questions: info@send21.io
