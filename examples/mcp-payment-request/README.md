# mcp-payment-request

Creates a send21 payment request (pay link) through the MCP server at https://send21.io/mcp and prints the link. The agent prepares the request. The payer signs in their own wallet.

```sh
npm install
npm run dry-run -- 25 EUR --option Usdc:Solana:<your-solana-address>   # no key needed
npm start -- 25 EUR --option Usdc:Solana:<your-solana-address>         # needs SEND21_API_KEY (drafts:write)
```

`client-config/` has ready-to-copy MCP client config for Cursor and Claude Desktop. See the [main README](../../README.md) for details.
