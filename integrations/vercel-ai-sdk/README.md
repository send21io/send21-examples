# ai-sdk-tool-send21

send21 tools for the [Vercel AI SDK](https://ai-sdk.dev). [send21](https://send21.io): crypto pay links and API for people and AI agents. Let an agent prepare a pay link and check its status without ever holding keys.

send21 is non-custodial software that prepares payment instructions. It never holds keys or funds, never signs and never broadcasts. The API key this package uses can create a pay link but cannot move money: the payer opens the link, picks a currency, scans one QR and signs in their own wallet.

Not an official Vercel package. Questions: info@send21.io

## Install

```sh
npm install ai-sdk-tool-send21 ai zod
```

Create a scoped key at https://send21.io/api-keys with `drafts:write` (create) and `drafts:read` (status), and set `SEND21_API_KEY`.

## Use

```ts
import { generateText, isStepCount } from "ai";
import { send21Tools } from "ai-sdk-tool-send21";

const tools = send21Tools({
  // Fix your own receiving addresses in code so the model never chooses one.
  receiveOptions: [
    { currency: "Usdc", network: "Solana", address: process.env.MY_SOLANA_ADDRESS! },
    { currency: "Btc", network: "Mainnet", address: "name@wallet.com", method: "Lightning" },
  ],
});

const { text } = await generateText({
  model: "openai/gpt-5-mini",
  tools,
  stopWhen: isStepCount(3),
  prompt: "Create a pay link for 40 EUR for order inv-1042.",
});
```

Tools:
- `send21CreatePayLink`: creates a payment request priced in any supported fiat currency and returns `payLink`, `paymentRequestId`, `status`, `expiresAt`. Each call sends a fresh `Idempotency-Key`; with an `orderId` it asks for `reuseOpenForOrder`, so a retry returns the open link instead of a second one.
- `send21GetPayLinkStatus`: `Open`, `Completed`, `Cancelled` or `Expired`, plus any "what changed" notes.

Supported: BTC on Bitcoin and over Lightning, USDC on Solana, Ethereum, Base, Arbitrum and Polygon, USDT on Solana and Ethereum, EURC on Solana, Ethereum and Base, SOL, ETH on Ethereum, Base and Arbitrum. The tool refuses other pairs before calling the API.

Payment confirmations arrive as signed webhooks; see the webhook receiver in https://github.com/send21io/send21-examples.

Prefer MCP? The same capabilities are on the hosted MCP server at https://send21.io/mcp.

## Develop

```sh
npm install && npm test   # offline tests with a fake fetch
```

MIT
