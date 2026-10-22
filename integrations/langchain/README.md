# langchain-send21

[send21](https://send21.io) tools for LangChain. Crypto pay links and API for people and AI agents. Let an agent prepare a pay link and check its status without holding keys.

send21 is non-custodial software that prepares payment instructions. It never holds keys or funds, never signs and never broadcasts. The scoped API key this package uses can create a pay link but cannot move money: the payer signs in their own wallet.

Not an official LangChain package. Questions: info@send21.io

- Website: https://send21.io
- Docs: https://send21.io/docs (MCP server: https://send21.io/docs/mcp, webhooks: https://send21.io/docs/webhooks)
- Examples and source: https://github.com/send21io/send21-examples

## Install

```sh
pip install langchain-send21
export SEND21_API_KEY=s21_...   # scopes: drafts:write, drafts:read (https://send21.io/api-keys)
```

## Use

```python
from langchain.agents import create_agent
from langchain_send21 import PayOption, Send21Toolkit

tools = Send21Toolkit(receive_options=[
    PayOption(currency="Usdc", network="Solana", address="<your-solana-address>"),
    PayOption(currency="Btc", network="Mainnet", address="name@wallet.com", method="Lightning"),
]).get_tools()

agent = create_agent("openai:gpt-5-mini", tools=tools)
agent.invoke({"messages": [{"role": "user", "content": "Create a pay link for 40 EUR for order inv-1042."}]})
```

- `send21_create_pay_link(fiat_amount, fiat_currency, order_id?, memo?, decline_note?)` returns `pay_link`, `payment_request_id`, `status`, `expires_at`. Receiving addresses come from your code, never from the model. Each call uses a fresh idempotency key, and with an `order_id` a retry returns the open link instead of creating a second one.
- `send21_get_pay_link_status(payment_request_id)` returns `Open`, `Completed`, `Cancelled` or `Expired` plus any "what changed" notes.

Supported pairs: BTC on Bitcoin and Lightning; USDC on Solana, Ethereum, Base, Arbitrum, Polygon; USDT on Solana and Ethereum; EURC on Solana, Ethereum, Base; SOL; ETH on Ethereum, Base, Arbitrum. Others are refused before any API call.

New send21 accounts only accept receiving addresses the owner approved: approve each `receive_options` address in send21 first (sign in, passkey or authenticator code). A 422 `address_not_approved` or 403 `owner_not_confirmed` comes back as a plain explanation the agent can relay, and nothing is created.

This toolkit calls the send21 REST API with a scoped API key. MCP clients, for example LangChain through `langchain-mcp-adapters`, can instead load all 14 send21 MCP tools: https://send21.io/mcp with the same API key, or https://send21.io/mcp/oauth with sign-in (OAuth), no key to copy.

## MCP via langchain-mcp-adapters

```sh
pip install langchain-mcp-adapters
```

With an API key, on `https://send21.io/mcp`:

```python
import os
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({"send21": {
    "transport": "streamable_http",
    "url": "https://send21.io/mcp",
    "headers": {"Authorization": f"Bearer {os.environ['SEND21_API_KEY']}"},
}})
tools = await client.get_tools()  # 14 tools: create_payment_request, get_payment_request, create_draft, ...
```

With sign-in, on `https://send21.io/mcp/oauth`: the owner signs in to send21 in the browser and approves the app. The MCP Python SDK's `OAuthClientProvider` handles discovery, client registration and PKCE; you supply token storage and the browser redirect/callback.

```python
from mcp.client.auth import OAuthClientProvider
from mcp.shared.auth import OAuthClientMetadata

auth = OAuthClientProvider(
    server_url="https://send21.io/mcp/oauth",
    client_metadata=OAuthClientMetadata(
        client_name="My LangChain agent",
        redirect_uris=["http://localhost:3030/callback"],
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
    ),
    storage=my_token_storage,               # your mcp.client.auth.TokenStorage
    redirect_handler=open_in_browser,       # async (url) -> None
    callback_handler=wait_for_callback,     # async () -> (code, state)
)
client = MultiServerMCPClient({"send21": {
    "transport": "streamable_http",
    "url": "https://send21.io/mcp/oauth",
    "auth": auth,
}})
tools = await client.get_tools()
```

A connected app only ever uses receiving addresses the owner approved, and the owner can disconnect it under https://send21.io/api-keys. Tools: create_draft, get_draft, get_draft_status, list_draft_quotes, get_transaction_template, submit_lightning_proof, create_payment_request, get_payment_request, list_address_book, propose_receiving_address, get_account_status, create_account, get_rate, get_fee_schedule. Details: https://send21.io/docs/mcp

## Develop

```sh
pip install -e '.[test]' && pytest   # offline, mocked HTTP
```

MIT
