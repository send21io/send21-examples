"""Minimal send21 REST client for the no-model path. The agent itself uses MCP."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from pay_options import SITE, pay_link

API = SITE + "/api/v1"


def request(method: str, path: str, api_key: str, body: dict | None = None, idempotency_key: str | None = None) -> dict:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()
        raise RuntimeError(f"send21 API {exc.code}: {detail}") from exc


def create_payment_request(api_key: str, body: dict, idempotency_key: str) -> dict:
    created = request("POST", "/payment-requests", api_key, body, idempotency_key)
    link = pay_link(created.get("payPath"))
    if link:
        created["payLink"] = link
    return created


def get_payment_request(api_key: str, payment_request_id: str) -> dict:
    return request("GET", f"/payment-requests/{payment_request_id}", api_key)
