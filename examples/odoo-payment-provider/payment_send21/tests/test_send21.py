# Runs inside Odoo: odoo-bin -i payment_send21 --test-tags /payment_send21
from odoo.tests import tagged

from odoo.addons.payment.tests.common import PaymentCommon
from odoo.addons.payment_send21 import send21_core


@tagged('post_install', '-at_install')
class TestSend21(PaymentCommon):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.provider = cls._prepare_provider('send21', update_values={
            'send21_api_key': 's21_test_only',
            'send21_webhook_secret': 'whsec_test_only_not_a_real_secret',
            'send21_receive_options': '[{"currency":"Usdc","network":"Base","address":"0xReceiver"}]',
        })
        cls.currency = cls.currency_euro

    def _confirmed(self, tx, **over):
        data = {
            'event': 'draft.confirmed', 'orderId': send21_core.order_id_for(tx.reference), 'txId': '5KqZ9bQ',
            'fiatCurrency': 'EUR', 'fiatAmount': tx.amount, 'sentAmount': '50.000000', 'sentCurrency': 'USDC', 'network': 'Solana',
        }
        data.update(over)
        return data

    def test_confirmed_sets_done(self):
        tx = self._create_transaction('redirect')
        tx._handle_notification_data('send21', self._confirmed(tx))
        self.assertEqual(tx.state, 'done')

    def test_other_amount_stays_pending(self):
        tx = self._create_transaction('redirect')
        tx._handle_notification_data('send21', self._confirmed(tx, fiatAmount=1.0))
        self.assertNotEqual(tx.state, 'done')

    def test_expired_cancels(self):
        tx = self._create_transaction('redirect')
        tx._handle_notification_data('send21', {'event': 'payment_request.expired', 'orderId': send21_core.order_id_for(tx.reference)})
        self.assertEqual(tx.state, 'cancel')


import json
import time

from odoo.addons.payment.tests.http_common import PaymentHttpCommon


@tagged('post_install', '-at_install')
class TestSend21Webhook(PaymentHttpCommon):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.provider = cls._prepare_provider('send21', update_values={
            'send21_api_key': 's21_test_only',
            'send21_webhook_secret': 'whsec_test_only_not_a_real_secret',
            'send21_receive_options': '[{"currency":"Usdc","network":"Base","address":"0xReceiver"}]',
        })
        cls.currency = cls.currency_euro

    def _post(self, payload, delivery_id, secret='whsec_test_only_not_a_real_secret', age=0):
        raw = json.dumps(payload).encode()
        headers = {
            'Content-Type': 'application/json',
            'X-Send21-Delivery': delivery_id,
            'X-Send21-Signature-V2': send21_core.sign_v2(raw, delivery_id, int(time.time()) - age, secret),
        }
        return self.url_open('/payment/send21/webhook', data=raw, headers=headers)

    def test_webhook_confirms_once_and_refuses_bad_signatures(self):
        tx = self._create_transaction('redirect')
        payload = {'event': 'draft.confirmed', 'data': {
            'orderId': send21_core.order_id_for(tx.reference), 'txId': '5KqZ9bQ', 'fiatCurrency': 'EUR', 'fiatAmount': tx.amount,
        }}
        self.assertEqual(self._post(payload, 'dlv_bad', secret='wrong').status_code, 401)
        self.assertEqual(self._post(payload, 'dlv_old', age=600).status_code, 401)
        tx.invalidate_recordset()
        self.assertEqual(tx.state, 'draft')

        self.assertEqual(self._post(payload, 'dlv_1').status_code, 200)
        self.assertEqual(self._post(payload, 'dlv_1').status_code, 200)
        tx.invalidate_recordset()
        self.assertEqual(tx.state, 'done')
        self.assertEqual(self.env['payment.send21.delivery'].sudo().search_count([('name', '=', 'dlv_1')]), 1)
