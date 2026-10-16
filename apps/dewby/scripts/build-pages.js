// Copies the PWA into <repo>/docs/dewby/ for GitHub Pages: dewby's own web/ plus the browser code
// it shares with send21-pair (lib/, vendor/). web/config.js as a static file switches the app to
// its client-side mock (no server, no key): data stays in the browser, links carry it between phones.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../web/", import.meta.url));
const shared = fileURLToPath(new URL("../../send21-pair/web/", import.meta.url));
const docs = fileURLToPath(new URL("../../../docs/", import.meta.url));
const out = `${docs}dewby/`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(`${shared}lib`, `${out}lib`, { recursive: true });
mkdirSync(`${out}vendor`);
cpSync(`${shared}vendor/qrcode.js`, `${out}vendor/qrcode.js`); // keeps its MIT license header
cpSync(web, out, { recursive: true });
writeFileSync(`${docs}.nojekyll`, "");
console.log(`Copied ${web} (+ shared lib/, vendor/) to ${out}`);
