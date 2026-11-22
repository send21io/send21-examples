app_name = "send21_payments"
app_title = "send21 Payments"
app_publisher = "send21"
app_description = "send21 crypto pay links for ERPNext Sales Invoices"
app_email = "info@send21.io"
app_license = "mit"
required_apps = ["erpnext"]

# Adds the "send21 Pay Link" field to Sales Invoice.
fixtures = [{"dt": "Custom Field", "filters": [["name", "in", ["Sales Invoice-send21_pay_link"]]]}]

doc_events = {
    "Sales Invoice": {
        "on_submit": "send21_payments.api.on_sales_invoice_submit",
    }
}

doctype_js = {"Sales Invoice": "public/js/sales_invoice.js"}
