import logging

import requests

from odoo import _, api, fields, models
from odoo.exceptions import ValidationError

from odoo.addons.payment_send21 import const, send21_core

_logger = logging.getLogger(__name__)


class PaymentProvider(models.Model):
    _inherit = 'payment.provider'

    code = fields.Selection(selection_add=[('send21', "send21")], ondelete={'send21': 'set default'})
    send21_api_key = fields.Char(
        string="send21 API Key",
        help="Key with drafts:read and drafts:write. It can create pay links; no key can move funds.",
        required_if_provider='send21',
        groups='base.group_system',
    )
    send21_webhook_secret = fields.Char(
        string="Webhook Signing Secret",
        help="Returned once by POST /api/v1/webhooks.",
        required_if_provider='send21',
        groups='base.group_system',
    )
    send21_receive_options = fields.Text(
        string="Receiving Options (JSON)",
        help='For example [{"currency":"Usdc","network":"Base","address":"0x..."}]. Use addresses you approved in send21.',
        groups='base.group_system',
    )
    send21_decline_note = fields.Char(
        string="If the Customer Does Not Pay",
        size=send21_core.DECLINE_NOTE_MAX,
        help='Shown on the send21 pay page as "If you don\'t pay:". Plain text, max 200 characters.',
    )
    send21_expiry_hours = fields.Integer(string="Pay Link Open For (hours)", default=24)

    @api.constrains('send21_receive_options', 'send21_expiry_hours')
    def _check_send21_settings(self):
        for provider in self.filtered(lambda p: p.code == 'send21'):
            if provider.send21_receive_options:
                try:
                    send21_core.parse_options(provider.sudo().send21_receive_options)
                except ValueError as error:
                    raise ValidationError(_("send21 receiving options: %s", error))
            if not 1 <= (provider.send21_expiry_hours or 24) <= 720:
                raise ValidationError(_("send21 pay links stay open 1 to 720 hours."))

    def _get_default_payment_method_codes(self):
        default_codes = super()._get_default_payment_method_codes()
        if self.code != 'send21':
            return default_codes
        return const.DEFAULT_PAYMENT_METHOD_CODES

    def _send21_make_request(self, endpoint, payload=None, method='POST', idempotency_key=None):
        self.ensure_one()
        headers = {'Authorization': f'Bearer {self.sudo().send21_api_key}', 'Accept': 'application/json'}
        if idempotency_key:
            headers['Idempotency-Key'] = idempotency_key
        url = f"{send21_core.SEND21_BASE_URL}/api/v1/{endpoint.strip('/')}"
        try:
            response = requests.request(method, url, json=payload, headers=headers, timeout=20)
            response.raise_for_status()
        except requests.exceptions.HTTPError:
            _logger.warning("send21 API error %s on %s", response.status_code, endpoint)
            raise ValidationError("send21: " + _("The pay link could not be created (HTTP %s).", response.status_code))
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
            raise ValidationError("send21: " + _("Could not reach send21."))
        return response.json()
