# The payment method activated with the provider (data/payment_method_data.xml).
DEFAULT_PAYMENT_METHOD_CODES = {'send21'}

# Events this module acts on. Others are acknowledged and ignored.
CONFIRMED = 'draft.confirmed'
EXPIRED = 'payment_request.expired'
REVIEW_EVENTS = {'draft.amount_mismatch', 'draft.mismatch_reminder', 'draft.mismatch_unresolved'}
