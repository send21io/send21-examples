# Changelog

## 0.1.4

- Wrapped BTC on Solana and WBTC on Ethereum: `PayOption(currency="Btc", network="Solana" | "Ethereum")`. Lightning stays Btc on Mainnet only.
- README: send21 MCP has 14 tools; this toolkit uses a REST API key, while MCP clients (e.g. langchain-mcp-adapters) can use https://send21.io/mcp with a key or https://send21.io/mcp/oauth with sign-in. New "MCP via langchain-mcp-adapters" section.

## 0.1.3

- Handles 422 address_not_approved and 403 owner_not_confirmed; README covers approved addresses.
