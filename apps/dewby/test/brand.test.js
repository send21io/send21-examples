import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadBrand } from "../server/brand.js";

const B = loadBrand();
const WEB = fileURLToPath(new URL("../web/", import.meta.url));
const APP = fileURLToPath(new URL("../", import.meta.url));
const read = (f) => readFileSync(join(WEB, f), "utf8");

function lum(hex) {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("brand.js has everything the UI and server read", () => {
  for (const k of ["name", "tagline", "description", "storagePrefix", "codeUrl", "light", "dark", "forcedDark", "avatars"]) assert.ok(B[k], k);
  assert.match(B.storagePrefix, /^[a-z0-9-]+$/);
  assert.notEqual(B.storagePrefix, "pair", "must not share browser storage with send21-pair on one origin");
  for (const pal of ["light", "dark"]) for (const k of ["bg", "surface", "ink", "muted", "mint", "lime", "sea", "pop", "link", "ok", "warn", "bad"]) assert.ok(B[pal][k], `${pal}.${k}`);
  for (const k of ["bg", "surface", "fill", "ink", "muted", "mint", "lime", "pop", "edge"]) assert.match(B.forcedDark[k], /^#[0-9A-F]{6}$/i, `forcedDark.${k}`);
});

test("text colors meet WCAG AA on their backgrounds", () => {
  for (const pal of [B.light, B.dark]) {
    for (const k of ["ink", "muted", "link", "ok", "warn", "bad"]) assert.ok(contrast(pal[k], pal.bg) >= 4.5, `${k} on bg: ${contrast(pal[k], pal.bg).toFixed(2)}`);
    for (const k of ["ink", "muted", "link"]) assert.ok(contrast(pal[k], pal.surface) >= 4.5, `${k} on surface`);
  }
  // Tiles, buttons and chips put the light theme's ink on the brand fills.
  for (const k of ["mint", "lime", "sea", "pop"]) assert.ok(contrast(B.light.ink, B.light[k]) >= 4.5, `ink on ${k}: ${contrast(B.light.ink, B.light[k]).toFixed(2)}`);
  for (const c of B.avatars) assert.ok(contrast(B.light.ink, c) >= 4.5, `ink on avatar ${c}`);
  const fd = B.forcedDark;
  for (const k of ["ink", "muted", "mint", "lime", "pop"]) assert.ok(contrast(fd[k], fd.fill) >= 4.5 && contrast(fd[k], fd.bg) >= 4.5, `forced dark ${k}`);
});

test("manifest and index.html match brand.js (run npm run brand after editing it)", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.equal(m.short_name, B.name);
  assert.equal(m.theme_color, B.light.bg);
  for (const i of m.icons) assert.ok(statSync(join(WEB, i.src)).size > 200, i.src);
  const html = read("index.html");
  assert.ok(html.includes(`<title>${B.name} · testnet</title>`));
  assert.ok(html.includes(`content="${B.light.bg}"`));
  assert.match(html, /<meta name="color-scheme" content="light only">/, "light by default, one scheme only");
  assert.ok(html.indexOf('<script src="brand.js">') > 0 && html.indexOf('<script src="brand.js">') < html.indexOf('<script src="theme.js">'), "brand.js loads before theme.js");
});

test("no send21 branding in the UI, except the optional powered-by line", () => {
  const files = ["index.html", "manifest.webmanifest", "app.js", "styles.css", "theme.js", "sw.js", "brand.js", "icons/mark.svg", "icons/logo.svg", "icons/wordmark.svg"];
  for (const f of files) {
    const code = read(f).split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n").replace(/\s\/\/\s.*$/gm, "").replace(/https:\/\/github\.com\/\S+/g, "").split(B.siteUrl).join(""); // hosting URLs (code, share card) are not UI copy
    const hits = code.match(/send21/gi) ?? [];
    if (f === "app.js") assert.deepEqual(hits, ["send21"], "only the powered-by line");
    else assert.equal(hits.length, 0, `${f} mentions send21`);
  }
  assert.match(read("app.js"), /B\.poweredBy \? `<p class="powered">powered by send21<\/p>`/);
});

test("public-content rules hold across the app folder", () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (["screenshots", "node_modules", "data"].includes(e.name) ? [] : walk(join(d, e.name))) : [join(d, e.name)]));
  for (const f of walk(APP).filter((p) => /\.(js|html|css|md|json|webmanifest|svg|txt)$/.test(p))) {
    const t = readFileSync(f, "utf8");
    assert.doesNotMatch(t, new RegExp(["twenty", "onesend"].join(""), "i"), f);
    for (const line of t.split("\n").filter((l) => /USDT/.test(l))) assert.match(line, /Solana|Ethereum/, `${f}: USDT only on Solana and Ethereum`);
    assert.doesNotMatch(t, /\b(we|send21|dewby) (hold|holds|keep|keeps|store|stores) (your )?(keys|funds|money)/i, `${f}: never claim custody`);
  }
});

test("share card: og/twitter meta point at a 1200x630 og.png on siteUrl", () => {
  const html = read("index.html");
  const meta = (k) => html.match(new RegExp(`<meta (?:property|name)="${k}" content="([^"]*)"`))?.[1];
  assert.equal(meta("og:title"), B.shareTitle);
  assert.equal(meta("og:description"), B.description);
  assert.equal(meta("og:url"), B.siteUrl);
  assert.equal(meta("og:image"), new URL("og.png", B.siteUrl).href);
  assert.equal(meta("twitter:card"), "summary_large_image");
  const png = readFileSync(join(WEB, "og.png"));
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  assert.ok(statSync(join(WEB, "og.png")).size < 1_000_000, "og.png under 1 MB");
});

test("manifest: installable fields, shortcuts and screenshots exist; favicon PNGs linked", () => {
  const m = JSON.parse(read("manifest.webmanifest"));
  for (const k of ["id", "lang", "start_url", "scope", "display", "categories", "shortcuts", "screenshots", "icons"]) assert.ok(m[k], k);
  for (const x of [...m.screenshots, ...m.icons]) assert.ok(statSync(join(WEB, x.src)).size > 0, x.src);
  assert.ok(m.icons.some((i) => i.purpose === "maskable"));
  const html = read("index.html");
  for (const f of ["icons/favicon-32.png", "icons/icon-180.png"]) { assert.ok(html.includes(`href="${f}"`), f); assert.ok(statSync(join(WEB, f)).size > 0, f); }
});
