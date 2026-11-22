# MIT License. See license.txt

from frappe.model.document import Document


class Send21Settings(Document):
	def validate(self):
		from send21_payments.send21_core import DECLINE_NOTE_MAX, parse_options

		if self.receive_options:
			parse_options(self.receive_options)
		if self.decline_note and len(self.decline_note) > DECLINE_NOTE_MAX:
			import frappe

			frappe.throw(f"The decline note can be at most {DECLINE_NOTE_MAX} characters.")
		self.expiry_hours = max(1, min(720, int(self.expiry_hours or 24)))
