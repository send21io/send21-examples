import { parseReceiveOptions } from "./send21.js";

export function loadConfig(env = process.env) {
  const need = (k) => {
    if (!env[k]) throw new Error(`${k} is not set (see .env.example)`);
    return env[k];
  };
  return {
    port: Number(env.PORT || 8787),
    send21ApiKey: need("SEND21_API_KEY"),
    send21WebhookSecret: need("SEND21_WEBHOOK_SECRET"),
    options: parseReceiveOptions(need("SEND21_OPTIONS")),
    declineNote: env.SEND21_DECLINE_NOTE,
    expiryHours: env.SEND21_EXPIRY_HOURS,
    invoiceNinjaUrl: need("INVOICENINJA_URL"),
    invoiceNinjaToken: need("INVOICENINJA_TOKEN"),
    invoiceNinjaWebhookToken: need("INVOICENINJA_WEBHOOK_TOKEN"),
    currency: env.INVOICENINJA_CURRENCY,
    linkField: env.INVOICENINJA_LINK_FIELD || "custom_value1",
    storePath: env.STORE_PATH || "./send21-invoiceninja.json",
  };
}
