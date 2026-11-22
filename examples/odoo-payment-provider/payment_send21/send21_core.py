"""Framework-free send21 rules for the Odoo module (no odoo import; unit-tested on its own).

Facts from https://send21.io/llms-full.txt and https://send21.io/swagger/v1/swagger.json.
"""

import hashlib
import hmac
import json
import re
import time

SEND21_BASE_URL = 'https://send21.io'
TOLERANCE_SECONDS = 300
DECLINE_NOTE_MAX = 200
DEFAULT_DECLINE_NOTE = "The order is not confirmed and nothing is shipped."
CURRENCIES = {'Btc', 'Usdc', 'Usdt', 'Eurc', 'Sol', 'Eth'}
NETWORKS = {'Mainnet', 'Solana', 'Ethereum', 'Base', 'Arbitrum', 'Polygon'}
METHODS = {'MultiOutput', 'Lightning'}


def order_id_for(reference):
    return f'odoo-{reference}'


def reference_from_order_id(order_id):
    order_id = str(order_id or '')
    return order_id[len('odoo-'):] if order_id.startswith('odoo-') else None


def clean_decline_note(note):
    text = re.sub(r'\s+', ' ', re.sub(r'<[^>]*>', '', note or '')).strip() or DEFAULT_DECLINE_NOTE
    return text if len(text) <= DECLINE_NOTE_MAX else text[:DECLINE_NOTE_MAX - 1].rstrip() + '…'


def parse_options(raw):
    items = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(items, list) or not items:
        raise ValueError("add at least one receiving option")
    out = []
    for i, o in enumerate(items, 1):
        if not isinstance(o, dict) or o.get('currency') not in CURRENCIES:
            raise ValueError(f"option {i}: unknown currency")
        if o.get('network') not in NETWORKS:
            raise ValueError(f"option {i}: unknown network")
        address = str(o.get('address') or '').strip()
        if len(address) < 3:
            raise ValueError(f"option {i}: address missing")
        item = {'currency': o['currency'], 'network': o['network'], 'address': address}
        if 'method' in o:
            if o['method'] not in METHODS:
                raise ValueError(f"option {i}: unknown method")
            item['method'] = o['method']
        out.append(item)
    return out


def build_payment_request(reference, amount, currency, options, decline_note=None, expiry_hours=24):
    """Return (body, idempotency_key) for POST /api/v1/payment-requests."""
    fiat = round(float(amount), 2)
    if fiat <= 0:
        raise ValueError("amount must be above zero")
    order_id = order_id_for(reference)
    body = {
        'fiatCurrency': str(currency).upper(),
        'fiatAmount': fiat,
        'orderId': order_id,
        'memo': f'Order {reference}'[:140],
        'expiryHours': max(1, min(720, int(expiry_hours or 24))),
        'declineNote': clean_decline_note(decline_note),
        'reuseOpenForOrder': True,
        'options': options,
    }
    return body, f'{order_id}-{fiat:.2f}'


def pay_link(pay_path):
    if not isinstance(pay_path, str) or not pay_path.startswith('/'):
        raise ValueError("payPath missing from the send21 response")
    return SEND21_BASE_URL + pay_path


def sign_v2(raw_body, delivery_id, timestamp, secret):
    mac = hmac.new(secret.encode(), f'{timestamp}.{delivery_id}.'.encode() + raw_body, hashlib.sha256).hexdigest()
    return f't={timestamp},v1={mac}'


def verify_signature_v2(raw_body, header, delivery_id, secret, now=None):
    if not secret or not header or not delivery_id:
        return False
    t = re.search(r'(?:^|,)\s*t=(\d+)', header)
    v1 = re.search(r'(?:^|,)\s*v1=([0-9a-f]{64})', header)
    if not t or not v1:
        return False
    if abs((time.time() if now is None else now) - int(t.group(1))) > TOLERANCE_SECONDS:
        return False
    expected = sign_v2(raw_body, delivery_id, t.group(1), secret).split(',v1=')[1]
    return hmac.compare_digest(expected, v1.group(1))


def decide(event, data, tx):
    """tx: dict with reference, amount, currency, provider_reference, state."""
    if data.get('orderId') != order_id_for(tx['reference']):
        return {'action': 'ignore', 'note': "orderId does not match"}
    if data.get('paymentRequestId') and tx.get('provider_reference') and data['paymentRequestId'] != tx['provider_reference']:
        return {'action': 'ignore', 'note': "another pay link"}
    if event == 'draft.confirmed':
        if tx.get('state') == 'done':
            return {'action': 'ignore', 'note': "already done"}
        same_currency = str(data.get('fiatCurrency', '')).upper() == str(tx['currency']).upper()
        same_amount = data.get('fiatAmount') is not None and round(float(data['fiatAmount']), 2) == round(float(tx['amount']), 2)
        if not (same_currency and same_amount):
            return {'action': 'review', 'note': f"confirmed {data.get('fiatAmount')} {data.get('fiatCurrency')}, expected {tx['amount']} {tx['currency']}"}
        return {'action': 'done', 'note': f"{data.get('sentAmount')} {data.get('sentCurrency')} on {data.get('network')}, tx {data.get('txId')}"}
    if event in ('draft.amount_mismatch', 'draft.mismatch_reminder', 'draft.mismatch_unresolved'):
        return {'action': 'review', 'note': f"{event}: accept or decline the transfer in send21; refunds are manual"}
    if event == 'payment_request.expired':
        if tx.get('state') == 'done':
            return {'action': 'ignore', 'note': "already done"}
        return {'action': 'cancel', 'note': "pay link expired unpaid" + (" (opened)" if data.get('opened') else '')}
    return {'action': 'ignore', 'note': f"event {event} not used"}
