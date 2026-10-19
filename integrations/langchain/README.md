# langchain-send21

send21 tools for LangChain. [send21](https://send21.io): crypto pay links and API for people and AI agents. Let an agent prepare a pay link and check its status without holding keys.

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

Already using MCP? `langchain-mcp-adapters` can load all 11 tools from https://send21.io/mcp directly.

## Develop

```sh
pip install -e '.[test]' && pytest   # offline, mocked HTTP
```

MIT
