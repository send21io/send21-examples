// Create a reusable send21 pay button (https://send21.io/b/<token>) to share in notes and profiles.
//   node --env-file=.env create-button.js "Buy me a coffee" 5 EUR
import { buildPaymentButton, parseOptions, send21Post } from "./src/send21.js";

const [name, amount, currency] = process.argv.slice(2);
if (!name || !(Number(amount) > 0) || !/^[A-Z]{3}$/.test(currency ?? "")) {
  console.error('usage: create-button.js "<title>" <amount> <CUR>');
  process.exit(1);
}
const button = await send21Post(fetch, process.env.SEND21_API_KEY, "payment-buttons", buildPaymentButton({ name, amount: Number(amount), currency }, parseOptions(process.env.SEND21_OPTIONS)));
console.log(button.url);
