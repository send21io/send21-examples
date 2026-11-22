// Make a fresh key for the bot. Put the nsec in .env (never commit it) and share only the npub.
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

const sk = generateSecretKey();
console.log(`NOSTR_SECRET_KEY=${nip19.nsecEncode(sk)}`);
console.error(`npub (share this): ${nip19.npubEncode(getPublicKey(sk))}`);
