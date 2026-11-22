import json
import logging

from odoo import http
from odoo.exceptions import ValidationError
from odoo.http import request

from odoo.addons.payment_send21 import send21_core

_logger = logging.getLogger(__name__)


class Send21Controller(http.Controller):
    _webhook_url = '/payment/send21/webhook'

    @http.route(_webhook_url, type='http', auth='public', methods=['POST'], csrf=False, save_session=False)
    def send21_webhook(self):
        raw = request.httprequest.get_data()
        headers = request.httprequest.headers
        delivery_id = headers.get('X-Send21-Delivery')
        signature = headers.get('X-Send21-Signature-V2')

        # Verify against the raw bytes with the secret of an enabled send21 provider, before
        # reading the body. (One endpoint per database; each company's provider is tried.)
        providers = request.env['payment.provider'].sudo().search([('code', '=', 'send21'), ('state', '!=', 'disabled')])
        if not any(send21_core.verify_signature_v2(raw, signature, delivery_id, p.send21_webhook_secret) for p in providers):
            return request.make_response('', status=401)

        Delivery = request.env['payment.send21.delivery'].sudo()
        if Delivery.search_count([('name', '=', delivery_id)]):
            return request.make_response('', status=200)  # already handled

        body = json.loads(raw)
        data = dict(body.get('data') or {}, event=body.get('event'))
        result = 'ignored'
        if send21_core.reference_from_order_id(data.get('orderId')):
            try:
                request.env['payment.transaction'].sudo()._handle_notification_data('send21', data)
                result = 'handled'
            except ValidationError:
                _logger.warning("send21: no matching transaction for %s", data.get('orderId'))
                result = 'no transaction'
        # Same database transaction as the payment update: both are committed, or neither.
        Delivery.create({'name': delivery_id, 'event': body.get('event'), 'result': result})
        return request.make_response('', status=200)
