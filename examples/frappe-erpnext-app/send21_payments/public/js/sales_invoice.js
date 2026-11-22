// Adds "Create > send21 pay link" to submitted, unpaid Sales Invoices.
frappe.ui.form.on("Sales Invoice", {
  refresh(frm) {
    if (frm.doc.docstatus !== 1 || !(frm.doc.outstanding_amount > 0)) return;
    frm.add_custom_button(__("send21 pay link"), () => {
      frappe.call({
        method: "send21_payments.api.create_pay_link",
        args: { sales_invoice: frm.doc.name },
        freeze: true,
        callback: (r) => {
          if (!r.message) return;
          frm.reload_doc();
          frappe.msgprint({
            title: __("Pay link"),
            indicator: "green",
            message: `<a href="${encodeURI(r.message)}" target="_blank" rel="noopener noreferrer">${frappe.utils.escape_html(r.message)}</a><br>${__("The customer signs and sends from their own wallet.")}`,
          });
        },
      });
    }, __("Create"));
  },
});
