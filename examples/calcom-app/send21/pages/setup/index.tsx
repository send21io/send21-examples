import { useState } from "react";

type Props = {
  configured: boolean;
  options: { currency: string; network: string; address: string; method?: string }[];
  declineNote: string;
  expiryHours: number;
};

const field = { width: "100%", padding: 8, border: "1px solid #D1D5DB", borderRadius: 8, background: "#FFFFFF", color: "#111827" } as const;

// Light setup form: send21 key, webhook signing secret, receiving addresses (JSON), decline note.
export default function Send21Setup(props: Props) {
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [options, setOptions] = useState(JSON.stringify(props.options.length ? props.options : [{ currency: "Usdc", network: "Base", address: "0xYourAddress" }], null, 2));
  const [declineNote, setDeclineNote] = useState(props.declineNote);
  const [expiryHours, setExpiryHours] = useState(props.expiryHours);
  const [message, setMessage] = useState("");

  async function save() {
    setMessage("");
    let parsedOptions: unknown;
    try {
      parsedOptions = JSON.parse(options);
    } catch {
      return setMessage("Receiving options must be valid JSON.");
    }
    const res = await fetch("/api/integrations/send21/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, webhookSecret, options: parsedOptions, declineNote: declineNote || undefined, expiryHours }),
    });
    const body = await res.json().catch(() => ({}));
    setMessage(res.ok ? "Saved." : body.message ?? "Could not save.");
  }

  return (
    <main style={{ background: "#F9FAFB", minHeight: "100vh", padding: 32, color: "#111827", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", background: "#FFFFFF", border: "1px solid #E5E7EB", borderRadius: 12, padding: 24, display: "grid", gap: 14 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Set up send21</h1>
        <p style={{ margin: 0, color: "#6B7280", fontSize: 14 }}>
          Create a send21 API key with drafts:read and drafts:write. It can prepare pay links but cannot move funds.
          {props.configured ? " A key is already saved; paste it again to change any setting." : ""}
        </p>
        <label>API key<input style={field} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="s21_..." /></label>
        <label>Webhook signing secret<input style={field} type="password" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} /></label>
        <label>Receiving options (JSON)<textarea style={{ ...field, minHeight: 120, fontFamily: "monospace" }} value={options} onChange={(e) => setOptions(e.target.value)} /></label>
        <label>If the booker does not pay (shown on the pay page, max 200 characters)<input style={field} maxLength={200} value={declineNote} onChange={(e) => setDeclineNote(e.target.value)} placeholder="The booking is released and the time slot opens for someone else." /></label>
        <label>Pay link open for (hours, 1 to 720)<input style={field} type="number" min={1} max={720} value={expiryHours} onChange={(e) => setExpiryHours(Number(e.target.value))} /></label>
        <button onClick={save} style={{ background: "#F7931A", color: "#FFFFFF", border: 0, borderRadius: 8, padding: "10px 16px", fontWeight: 600, cursor: "pointer" }}>Save</button>
        {message && <p style={{ margin: 0, fontSize: 14 }}>{message}</p>}
      </div>
    </main>
  );
}

export { getServerSideProps } from "./_getServerSideProps";
