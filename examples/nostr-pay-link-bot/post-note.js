// Publish a kind-1 note with a send21 pay button or pay link.
//   node --env-file=.env post-note.js https://send21.io/b/<token> "Tips welcome"
import { SimplePool } from "nostr-tools";

import { payNote, secretKeyFrom } from "./src/bot.js";

const [url, text = "Pay with crypto:"] = process.argv.slice(2);
const event = payNote(secretKeyFrom(process.env.NOSTR_SECRET_KEY), { text, url });
const relays = process.env.NOSTR_RELAYS.split(",").map((s) => s.trim());
const pool = new SimplePool();
const results = await Promise.allSettled(pool.publish(relays, event));
console.log(`note ${event.id}: ${results.filter((r) => r.status === "fulfilled").length}/${relays.length} relays accepted`);
pool.close(relays);
