// Copies the PWA into <repo>/docs/pair/ for GitHub Pages. web/config.js as a
// static file switches the app to its client-side mock (no server, no key):
// data stays in the browser and links/QR codes carry it between phones.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const docs = fileURLToPath(new URL("../../../docs/", import.meta.url));
const out = `${docs}pair/`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(web, out, { recursive: true });
writeFileSync(`${docs}.nojekyll`, "");
console.log(`Copied ${web} to ${out}`);
