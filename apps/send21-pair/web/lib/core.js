// Shared by the browser and the Node backend: the asset catalog, the smart
// default, amount math, wallet deep links and plain-language status.
// No dependencies, no Node or DOM APIs.

/**
 * The assets a receiver can accept. `testnet` is what the prototype uses;
 * `live` is the same asset on send21's live networks (API mode only).
 * Token addresses and URI formats are the ones send21's testnet demo returns
 * (POST /api/v1/demo/drafts), so mock links look exactly like real ones.
 */
export const ASSETS = {
  "usdc-sol": { label: "USDC", chain: "Solana", currency: "Usdc", decimals: 6, kind: "spl",
    testnet: { network: "SolanaDevnet", token: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", name: "Solana Devnet" },
    live: { network: "Solana", name: "Solana" } },
  "eurc-sol": { label: "EURC", chain: "Solana", currency: "Eurc", decimals: 6, kind: "spl",
    testnet: { network: "SolanaDevnet", token: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", name: "Solana Devnet" },
    live: { network: "Solana", name: "Solana" } },
  "usdc-base": { label: "USDC", chain: "Base", currency: "Usdc", decimals: 6, kind: "erc20",
    testnet: { network: "BaseSepolia", token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", chainId: 84532, name: "Base Sepolia" },
    live: { network: "Base", chainId: 8453, name: "Base" } },
  "eurc-base": { label: "EURC", chain: "Base", currency: "Eurc", decimals: 6, kind: "erc20",
    testnet: { network: "BaseSepolia", token: "0x808456652fdb597867f38412077A9182bf77359F", chainId: 84532, name: "Base Sepolia" },
    live: { network: "Base", chainId: 8453, name: "Base" } },
  "sol": { label: "SOL", chain: "Solana", currency: "Sol", decimals: 9, kind: "sol",
    testnet: { network: "SolanaDevnet", name: "Solana Devnet" },
    live: { network: "Solana", name: "Solana" } },
  "eth-base": { label: "ETH", chain: "Base", currency: "Eth", decimals: 9, kind: "eth",
    testnet: { network: "BaseSepolia", chainId: 84532, name: "Base Sepolia" },
    live: { network: "Base", chainId: 8453, name: "Base" } },
  "btc": { label: "BTC", chain: "Bitcoin", currency: "Btc", decimals: 8, kind: "btc",
    testnet: { network: "Testnet4", name: "Bitcoin Testnet4" },
    live: { network: "Mainnet", name: "Bitcoin" } },
  "usdc-eth": { label: "USDC", chain: "Ethereum", currency: "Usdc", decimals: 6, kind: "erc20",
    testnet: { network: "EthereumSepolia", token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", chainId: 11155111, name: "Ethereum Sepolia" },
    live: { network: "Ethereum", chainId: 1, name: "Ethereum" } },
  // Lightning has no test network in the send21 demo, so it is live (API mode) only.
  "btc-ln": { label: "BTC", chain: "Lightning", currency: "Btc", decimals: 8, kind: "lightning", method: "Lightning",
    testnet: null,
    live: { network: "Mainnet", name: "Lightning" } },
};

/** Cheapest and fastest first. EUR amounts prefer EURC (no FX for either side). */
const PREFERENCE = ["btc-ln", "usdc-sol", "eurc-sol", "usdc-base", "eurc-base", "sol", "eth-base", "btc", "usdc-eth"];

export function assetsFor(mode) {
  const net = mode === "api" ? "live" : "testnet";
  return Object.entries(ASSETS).filter(([, a]) => a[net]).map(([id]) => id);
}

export function networkOf(assetId, mode) {
  const a = ASSETS[assetId];
  return a?.[mode === "api" ? "live" : "testnet"] ?? null;
}

/**
 * Pick the asset the payer will use: the first in PREFERENCE that the receiver
 * accepts on this mode's networks. EUR prefers EURC, other currencies prefer USDC.
 * @param {string[]} accepted asset ids the receiver has an address for
 * @param {string} fiat ISO currency of the amount
 * @param {string} mode mock | demo | api
 */
export function pickAsset(accepted, fiat, mode = "mock") {
  const usable = new Set(accepted.filter((id) => networkOf(id, mode)));
  let order = PREFERENCE;
  if (fiat === "EUR") {
    order = [...PREFERENCE].sort((x, y) => rankEur(x) - rankEur(y));
  }
  return order.find((id) => usable.has(id)) ?? null;
}
const rankEur = (id) => {
  const base = PREFERENCE.indexOf(id);
  if (id === "eurc-sol") return PREFERENCE.indexOf("usdc-sol") - 0.5;
  if (id === "eurc-base") return PREFERENCE.indexOf("usdc-base") - 0.5;
  return base;
};

// Mock exchange rates (USD per unit, and units of fiat per USD). Clearly labeled
// in the UI as mock. API mode lets send21 price the draft (fiatCurrency +
// fiatAmount, rate locked by send21) and shows send21's amount.
export const MOCK_USD_PER_ASSET = { Usdc: 1, Eurc: 1.08, Btc: 98000, Sol: 150, Eth: 3500 };
export const MOCK_FIAT_PER_USD = {
  USD: 1, EUR: 0.925, SEK: 10.6, NOK: 10.9, DKK: 6.9, GBP: 0.78, CHF: 0.88, PLN: 4.0,
  NGN: 1550, KES: 129, GHS: 15.5, ZAR: 18.2, MXN: 18.6, BRL: 5.4, ARS: 980, COP: 4100,
  PEN: 3.75, CLP: 940, INR: 84, PHP: 57, IDR: 15600, VND: 25000, KRW: 1350, JPY: 150,
  AUD: 1.5, CAD: 1.37, TRY: 34, AED: 3.67,
};
export const FIATS = Object.keys(MOCK_FIAT_PER_USD);

/** Fiat currency from a BCP-47 locale ("sv-SE" gives SEK). */
export function fiatForLocale(locale = "en-US") {
  const region = String(locale).split(/[-_]/)[1]?.toUpperCase();
  const map = { SE: "SEK", NO: "NOK", DK: "DKK", GB: "GBP", CH: "CHF", PL: "PLN", NG: "NGN", KE: "KES",
    GH: "GHS", ZA: "ZAR", MX: "MXN", BR: "BRL", AR: "ARS", CO: "COP", PE: "PEN", CL: "CLP", IN: "INR",
    PH: "PHP", ID: "IDR", VN: "VND", KR: "KRW", JP: "JPY", AU: "AUD", CA: "CAD", TR: "TRY", AE: "AED", US: "USD" };
  const euro = ["DE", "FR", "ES", "IT", "NL", "BE", "AT", "FI", "IE", "PT", "GR", "SK", "SI", "EE", "LV", "LT", "LU", "MT", "CY", "HR"];
  if (region && map[region]) return map[region];
  if (region && euro.includes(region)) return "EUR";
  return "USD";
}

/** Mock conversion: fiat amount to integer base units of the asset. */
export function mockBaseUnits(fiatAmount, fiat, assetId) {
  const a = ASSETS[assetId];
  const usd = Number(fiatAmount) / (MOCK_FIAT_PER_USD[fiat] ?? 1);
  return Math.max(1, Math.round((usd / MOCK_USD_PER_ASSET[a.currency]) * 10 ** a.decimals));
}

/** Base units to a decimal string, exact (BigInt). 1234500, 6 gives "1.2345". */
export function formatUnits(baseUnits, decimals, { trim = true } = {}) {
  const n = BigInt(baseUnits);
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(decimals + 1, "0");
  let whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals);
  if (trim) frac = frac.replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}

export function formatFiat(amount, fiat, locale) {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: fiat, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${Number(amount).toFixed(2)} ${fiat}`;
  }
}

/** "≈ 11.42 USDC" for display (rounded for reading; the link carries the exact amount). */
export function cryptoLine(baseUnits, assetId, mode = "mock") {
  const a = ASSETS[assetId];
  const exact = formatUnits(baseUnits, a.decimals);
  const shown = a.currency === "Usdc" || a.currency === "Eurc" ? Number(exact).toFixed(2) : exact;
  const net = networkOf(assetId, mode);
  return { amount: shown, exact, symbol: a.label, network: net?.name ?? a.chain };
}

/**
 * Wallet deep link in the same formats send21 returns as `paymentUri`.
 * Used in mock mode only; demo and API mode show send21's paymentUri verbatim.
 */
export function paymentUri({ assetId, address, baseUnits, mode = "mock", message }) {
  const a = ASSETS[assetId];
  const net = networkOf(assetId, mode);
  const amount = formatUnits(baseUnits, a.decimals, { trim: false });
  const enc = encodeURIComponent;
  switch (a.kind) {
    case "btc":
      return `bitcoin:${address}?amount=${amount}` + (message ? `&message=${enc(message)}` : "");
    case "sol":
      return `solana:${address}?amount=${amount}` + (message ? `&message=${enc(message)}` : "");
    case "spl":
      return `solana:${address}?amount=${amount}&spl-token=${net.token}` + (message ? `&message=${enc(message)}` : "");
    case "erc20":
      return `ethereum:${net.token}@${net.chainId}/transfer?address=${address}&uint256=${BigInt(baseUnits)}`;
    case "eth":
      // ETH base units are gwei; EIP-681 carries wei.
      return `ethereum:${address}@${net.chainId}?value=${BigInt(baseUnits) * 1000000000n}`;
    default:
      return null; // Lightning needs an invoice from send21.
  }
}

/** Loose format check per asset family, so a typo is caught before a request exists. */
export function validAddress(assetId, address, mode = "mock") {
  const a = ASSETS[assetId];
  if (!a || typeof address !== "string") return false;
  const s = address.trim();
  switch (a.kind) {
    case "btc":
      return mode === "api" ? /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,90}$/.test(s) : /^(tb1|[mn2])[a-zA-HJ-NP-Z0-9]{20,90}$/.test(s);
    case "spl":
    case "sol":
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
    case "erc20":
    case "eth":
      return /^0x[0-9a-fA-F]{40}$/.test(s) && !/^0x0{40}$/.test(s);
    case "lightning":
      return /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(s);
    default:
      return false;
  }
}

/** Plain-language status, from the point of view of `me`. */
export function statusText(req, me) {
  const iAmReceiver = req.to_user === me;
  const other = iAmReceiver ? req.payer_name ?? "them" : req.receiver_name ?? "them";
  switch (req.status) {
    case "awaiting":
      if (iAmReceiver) return req.from_user ? `Waiting for ${other} to pay` : "Waiting for someone to pay";
      return `${other} is waiting for you`;
    case "seen":
      return iAmReceiver ? `${req.from_user ? other : "Someone"} is paying…` : "Payment on its way…";
    case "paid":
      return "Paid ✓";
    case "review":
      return iAmReceiver ? "Check the amount" : `Sent. ${other} is checking the amount`;
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    default:
      return req.status;
  }
}

export const FINAL = new Set(["paid", "expired", "cancelled"]);
const ORDER = { awaiting: 0, seen: 1, review: 2, paid: 3, expired: 3, cancelled: 3 };
/** A request never moves backwards (a late draft.seen after paid is ignored). */
export function canMove(from, to) {
  if (from === to) return false;
  if (FINAL.has(from)) return false;
  return ORDER[to] >= ORDER[from] || (from === "review" && to === "paid");
}

const COLORS = ["#F7931A", "#E4572E", "#3A86FF", "#2EC4B6", "#8338EC", "#FF006E", "#6A994E", "#FFBE0B"];
export function avatarColor(seed) {
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
export function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Split `total` into `parts` shares in cents that add up exactly. */
export function splitAmount(total, parts) {
  const cents = Math.round(Number(total) * 100);
  const base = Math.floor(cents / parts);
  const rest = cents - base * parts;
  return Array.from({ length: parts }, (_, i) => (base + (i < rest ? 1 : 0)) / 100);
}

// base64url of UTF-8 JSON, for the static (GitHub Pages) demo where links carry the data.
export function encodeCard(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCard(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** The public send21 testnet demo receive wallets, prefilled so anyone can try it. */
export const DEMO_ADDRESSES = {
  "usdc-sol": "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ",
  "eurc-sol": "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ",
  "sol": "HQCmjaAUDfCzPxMyQZHZ4YWL2YNdkJoVPt8q8v3oUcGJ",
  "usdc-base": "0x54d4ddfD8A8C582Ae55450c573617D5bccF860F8",
  "eurc-base": "0x54d4ddfD8A8C582Ae55450c573617D5bccF860F8",
  "eth-base": "0x54d4ddfD8A8C582Ae55450c573617D5bccF860F8",
  "btc": "tb1qgpjc5kgwm5ktzfl78z3499p4xqu5vsy7zuk8e7",
};

/** A random id that also works on plain-http LAN pages (crypto.randomUUID needs a secure context). */
export function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
