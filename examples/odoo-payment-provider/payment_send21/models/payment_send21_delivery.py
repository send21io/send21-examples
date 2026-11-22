from odoo import fields, models


class PaymentSend21Delivery(models.Model):
    """Handled X-Send21-Delivery ids. send21 retries reuse the id and do not dedupe for you."""

    _name = 'payment.send21.delivery'
    _description = "send21 Webhook Delivery"
    _order = 'id desc'

    name = fields.Char(string="Delivery ID", required=True, index=True, readonly=True)
    event = fields.Char(readonly=True)
    result = fields.Char(readonly=True)

    _sql_constraints = [('name_unique', 'unique(name)', "This delivery was already handled.")]
