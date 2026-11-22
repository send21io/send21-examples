import z from "zod";

const option = z.object({
  currency: z.enum(["Btc", "Usdc", "Usdt", "Eurc", "Sol", "Eth"]),
  network: z.enum(["Mainnet", "Solana", "Ethereum", "Base", "Arbitrum", "Polygon"]),
  address: z.string().min(3),
  method: z.enum(["MultiOutput", "Lightning"]).optional(),
});

// Stored on the Cal.com credential. apiKey is a send21 key with drafts:read and drafts:write;
// it can create pay links but cannot move funds. webhookSecret is the signing secret send21
// returned once when the webhook endpoint was registered.
export const send21CredentialKeysSchema = z.object({
  apiKey: z.string().startsWith("s21_"),
  webhookSecret: z.string().min(16),
  options: z.array(option).min(1),
  declineNote: z.string().max(200).optional(),
  expiryHours: z.number().int().min(1).max(720).optional(),
});
