// A light "Pay with crypto" card for Cal.com's payment page. Render it with the payment's
// stored data, for example <Send21PayLink payLink={payment.data.payLink} ... />.
type Props = { payLink: string; amount: string; currency: string; expiresAt?: string };

export default function Send21PayLink({ payLink, amount, currency, expiresAt }: Props) {
  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 12, padding: 20, color: "#111827", maxWidth: 420 }}>
      <p style={{ margin: 0, fontSize: 14, color: "#6B7280" }}>Amount due</p>
      <p style={{ margin: "4px 0 16px", fontSize: 24, fontWeight: 600 }}>
        {amount} {currency}
      </p>
      <a
        href={payLink}
        rel="noopener noreferrer"
        style={{ display: "inline-block", background: "#F7931A", color: "#FFFFFF", padding: "10px 18px", borderRadius: 8, fontWeight: 600, textDecoration: "none" }}>
        Pay with crypto
      </a>
      <p style={{ margin: "12px 0 0", fontSize: 13, color: "#6B7280" }}>
        You sign and send from your own wallet, straight to the host.
        {expiresAt ? ` The link is open until ${new Date(expiresAt).toLocaleString()}.` : ""}
      </p>
    </div>
  );
}
