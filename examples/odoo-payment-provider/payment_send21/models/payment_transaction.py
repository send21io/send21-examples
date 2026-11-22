import logging

from odoo import _, models
from odoo.exceptions import ValidationError

from odoo.addons.payment_send21 import send21_core

_logger = logging.getLogger(__name__)


class PaymentTransaction(models.Model):
    _inherit = 'payment.transaction'

    def _get_specific_rendering_values(self, processing_values):
        """Create the send21 pay link and redirect the customer to it."""
        res = super()._get_specific_rendering_values(processing_values)
        if self.provider_code != 'send21':
            return res

        provider = self.provider_id.sudo()
        body, idempotency_key = send21_core.build_payment_request(
            self.reference,
            self.amount,
            self.currency_id.name,
            send21_core.parse_options(provider.send21_receive_options),
            decline_note=provider.send21_decline_note,
            expiry_hours=provider.send21_expiry_hours,
        )
        data = self.provider_id._send21_make_request('payment-requests', body, idempotency_key=idempotency_key)
        self.provider_reference = data.get('id')
        link = send21_core.pay_link(data.get('payPath'))
        self._set_pending(state_message=_("Waiting for the payment on send21. The customer signs and sends from their own wallet."))
        return {'api_url': link}

    def _get_tx_from_notification_data(self, provider_code, notification_data):
        tx = super()._get_tx_from_notification_data(provider_code, notification_data)
        if provider_code != 'send21' or len(tx) == 1:
            return tx
        reference = send21_core.reference_from_order_id(notification_data.get('orderId'))
        tx = self.search([('reference', '=', reference), ('provider_code', '=', 'send21')]) if reference else self
        if not tx:
            raise ValidationError("send21: " + _("No transaction found matching order %s.", notification_data.get('orderId')))
        return tx

    def _process_notification_data(self, notification_data):
        """notification_data is the verified webhook body's `data`, plus `event`."""
        super()._process_notification_data(notification_data)
        if self.provider_code != 'send21':
            return

        decision = send21_core.decide(notification_data.get('event'), notification_data, {
            'reference': self.reference,
            'amount': self.amount,
            'currency': self.currency_id.name,
            'provider_reference': self.provider_reference,
            'state': self.state,
        })
        _logger.info("send21 %s for %s: %s", notification_data.get('event'), self.reference, decision['action'])
        if decision['action'] == 'done':
            self._set_done(state_message=decision['note'])
        elif decision['action'] == 'review':
            self._set_pending(state_message="send21: " + decision['note'])
        elif decision['action'] == 'cancel':
            self._set_canceled(state_message="send21: " + decision['note'])
