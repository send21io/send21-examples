import os

from langchain.agents import create_agent  # langchain>=1.0
from langchain_send21 import PayOption, Send21Toolkit

tools = Send21Toolkit(receive_options=[
    PayOption(currency="Usdc", network="Solana", address=os.environ["MY_SOLANA_ADDRESS"]),
    PayOption(currency="Btc", network="Mainnet", address=os.environ["MY_LIGHTNING_ADDRESS"], method="Lightning"),
]).get_tools()

agent = create_agent("openai:gpt-5-mini", tools=tools)
result = agent.invoke({"messages": [{"role": "user", "content": "Create a pay link for 40 EUR for order inv-1042."}]})
print(result["messages"][-1].content)
