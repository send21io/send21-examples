// Receive options: which assets the shop accepts and where each one is paid.
// They come from the server's environment (SEND21_OPTIONS) and are never taken
// from the browser, so a customer cannot swap in their own address.
//
// Values are the API enums from https://send21.io/openapi.json
// (PaymentRequestOptionDto: currency, network, address, method) and the
// combinations from https://send21.io/docs/currencies.

/** Network (API value) -> currencies (API values) send21 carries there. */
export const SUPPORTED = {
  Mainnet: ["Btc"],
  Solana: ["Usdc", "Usdt", "Eurc", "Sol", "Btc"],
  Ethereum: ["Usdc", "Usdt", "Eurc", "Eth", "Btc"],
  Base: ["Usdc", "Eurc", "Eth"],
  Arbitrum: ["Usdc", "Eth"],
  Polygon: ["Usdc"],
};
const METHODS = ["MultiOutput", "Lightning"];

const canon = (value, list) => list.find((v) => v.toLowerCase() === String(value ?? "").trim().toLowerCase());

/**
 * Parse "Currency:Network:Address[:Method]" entries separated by commas or
 * newlines (same format as the mcp-payment-request example), or a JSON array of
 * { currency, network, address, method? }.
 * @param {string} input
 * @returns {{ currency: string, network: string, address: string, method?: string }[]}
 */
export function parseOptions(input) {
  const text = String(input ?? "").trim();
  if (!text) return [];
  const raw = text.startsWith("[")
    ? JSON.parse(text)
    : text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).map((entry) => {
        const [currency, network, address, method] = entry.split(":").map((s) => s.trim());
        return { currency, network, address, method };
      });
  return raw.map(validateOption);
}

/** Throws when the currency/network pair is not one send21 supports. */
export function validateOption(option) {
  const network = canon(option.network, Object.keys(SUPPORTED));
  if (!network) throw new Error(`unsupported network "${option.network}"`);
  const currency = canon(option.currency, SUPPORTED[network]);
  if (!currency) throw new Error(`${option.currency} is not offered on ${network}`);
  const address = String(option.address ?? "").trim();
  if (!address) throw new Error(`${currency} on ${network}: receive address is missing`);
  const out = { currency, network, address };
  if (option.method) {
    const method = canon(option.method, METHODS);
    if (!method) throw new Error(`unknown method "${option.method}"`);
    if (method === "Lightning" && !(currency === "Btc" && network === "Mainnet")) throw new Error("Lightning is only for Btc on Mainnet");
    out.method = method;
  }
  return out;
}

const NAMES = { Btc: "BTC", Usdc: "USDC", Usdt: "USDT", Eurc: "EURC", Sol: "SOL", Eth: "ETH" };
const NETWORKS = { Mainnet: "Bitcoin" };

/** Public description of an option for the browser: no address. */
export function describeOption({ currency, network, method }) {
  const asset = currency === "Btc" && network !== "Mainnet" ? (network === "Ethereum" ? "WBTC" : "Wrapped BTC") : NAMES[currency];
  const net = method === "Lightning" ? "Lightning" : NETWORKS[network] ?? network;
  return { currency, network, ...(method ? { method } : {}), label: `${asset} on ${net}` };
}
