# Installing the send21 MCP server

send21 is a remote MCP server. Nothing needs to be cloned or built.

1. Endpoint: `https://send21.io/mcp` (Streamable HTTP).
2. `tools/list` and `get_fee_schedule` work without a key. For everything else, ask the user for a send21 API key created at https://send21.io/api-keys. Suggest the smallest scopes: `drafts:read` and `drafts:write`. No send21 key can move funds.
3. Add to the MCP settings:

```json
{
  "mcpServers": {
    "send21": {
      "url": "https://send21.io/mcp",
      "headers": { "Authorization": "Bearer s21_your_key_here" }
    }
  }
}
```

If the client only supports stdio servers, use mcp-remote:

```json
{
  "mcpServers": {
    "send21": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://send21.io/mcp", "--header", "Authorization:${SEND21_AUTH_HEADER}"],
      "env": { "SEND21_AUTH_HEADER": "Bearer s21_your_key_here" }
    }
  }
}
```

4. Verify: call `get_fee_schedule`. It should return the tiered fee table.

Never ask for wallet seeds or private keys. send21 does not use them: the payer signs in their own wallet.
