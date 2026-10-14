import { generateText, isStepCount } from "ai";

import { send21Tools } from "ai-sdk-tool-send21";

const tools = send21Tools({
  // Fix the receiving addresses in code so the model can never pick one.
  receiveOptions: [
    { currency: "Usdc", network: "Solana", address: process.env.MY_SOLANA_ADDRESS! },
    { currency: "Btc", network: "Mainnet", address: process.env.MY_LIGHTNING_ADDRESS!, method: "Lightning" },
  ],
});

const { text } = await generateText({
  model: "openai/gpt-5-mini" // via AI Gateway; any provider works,
  tools,
  stopWhen: isStepCount(3),
  prompt: "Create a pay link for 40 EUR for order inv-1042, memo 'Logo design, round 2'.",
});
console.log(text);
