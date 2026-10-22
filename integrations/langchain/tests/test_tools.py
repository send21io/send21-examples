import json

import httpx
import pytest

from langchain_send21 import PayOption, Send21Client, Send21CreatePayLinkTool


def make_client(seen):
    def handler(req: httpx.Request):
        seen.append(req)
        return httpx.Response(201, json={"id": "abc", "payPath": "/pay/xyz", "status": "Open", "expiresAt": "2026-10-15T20:00:00Z"})
    return Send21Client("s21_test", http=httpx.Client(transport=httpx.MockTransport(handler)))


def test_create_pay_link():
    seen = []
    tool = Send21CreatePayLinkTool(make_client(seen), [PayOption(currency="Usdc", network="Solana", address="OWN")])
    out = tool.invoke({"fiat_amount": 25, "fiat_currency": "eur", "order_id": "inv-1"})
    assert out["pay_link"] == "https://send21.io/pay/xyz"
    body = json.loads(seen[0].content)
    assert body["fiatCurrency"] == "EUR" and body["options"][0]["address"] == "OWN" and body["reuseOpenForOrder"]
    assert seen[0].headers["Idempotency-Key"] and seen[0].headers["Authorization"] == "Bearer s21_test"


def test_rejects_usdt_on_polygon():
    with pytest.raises(ValueError):
        Send21CreatePayLinkTool(make_client([]), [PayOption(currency="Usdt", network="Polygon", address="x")])


@pytest.mark.parametrize("status,code,text", [(422, "address_not_approved", "not approved"), (403, "owner_not_confirmed", "taken over")])
def test_explains_approval_errors(status, code, text):
    client = Send21Client("s21_test", http=httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(status, json={"error": code}))))
    tool = Send21CreatePayLinkTool(client, [PayOption(currency="Usdc", network="Solana", address="OWN")])
    with pytest.raises(RuntimeError, match=text):
        tool.invoke({"fiat_amount": 25, "fiat_currency": "eur"})


@pytest.mark.parametrize("network", ["Mainnet", "Solana", "Ethereum"])
def test_accepts_btc_and_wrapped_btc(network):
    seen = []
    tool = Send21CreatePayLinkTool(make_client(seen), [PayOption(currency="Btc", network=network, address="OWN")])
    tool.invoke({"fiat_amount": 25, "fiat_currency": "eur"})
    opt = json.loads(seen[0].content)["options"][0]
    assert opt["currency"] == "Btc" and opt["network"] == network


@pytest.mark.parametrize("network", ["Base", "Arbitrum", "Polygon"])
def test_rejects_btc_elsewhere(network):
    with pytest.raises(ValueError):
        Send21CreatePayLinkTool(make_client([]), [PayOption(currency="Btc", network=network, address="x")])


def test_lightning_only_on_mainnet():
    Send21CreatePayLinkTool(make_client([]), [PayOption(currency="Btc", network="Mainnet", address="a@b.com", method="Lightning")])
    with pytest.raises(ValueError):
        Send21CreatePayLinkTool(make_client([]), [PayOption(currency="Btc", network="Solana", address="x", method="Lightning")])
