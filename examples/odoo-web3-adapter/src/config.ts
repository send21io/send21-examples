import { parseOptions } from "./send21.ts";

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set (see .env.example)`);
    return v;
  };
  return {
    port: Number(env.PORT || 8790),
    storePath: env.STORE_PATH || "./send21-odoo-web3.json",
    odoo: { url: need("ODOO_URL"), db: need("ODOO_DATABASE"), username: need("ODOO_USERNAME"), password: need("ODOO_PASSWORD") },
    adapter: {
      send21ApiKey: need("SEND21_API_KEY"),
      send21WebhookSecret: need("SEND21_WEBHOOK_SECRET"),
      options: parseOptions(need("SEND21_OPTIONS")),
      declineNote: env.SEND21_DECLINE_NOTE,
      expiryHours: env.SEND21_EXPIRY_HOURS ? Number(env.SEND21_EXPIRY_HOURS) : 24,
      journalId: Number(need("ODOO_JOURNAL_ID")),
    },
  };
}
