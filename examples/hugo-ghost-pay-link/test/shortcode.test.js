import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("Hugo shortcode and Ghost embed", () => {
  const shortcode = readFileSync(join(root, "layouts/shortcodes/send21-pay.html"), "utf8");
  const css = readFileSync(join(root, "assets/css/send21-pay.css"), "utf8");
  const ghost = readFileSync(join(root, "ghost-embed.html"), "utf8");

  it("requires a pay link and renders the amount and button", () => {
    assert.match(shortcode, /\$link := \.Get "link"/);
    assert.match(shortcode, /errorf "send21-pay shortcode requires a link/);
    assert.match(shortcode, /send21-pay__button/);
    assert.match(shortcode, /\$amount/);
    assert.match(shortcode, /\$currency/);
  });

  it("uses send21 orange only as the button accent", () => {
    assert.match(css, /--send21-accent: #f7931a/i);
    assert.match(css, /--send21-bg: #ffffff/i);
    assert.match(css, /\.send21-pay__button \{[\s\S]*background: var\(--send21-accent\)/);
    assert.doesNotMatch(css, /background:\s*var\(--send21-accent\);[\s\S]*\.send21-pay \{/);
  });

  it("tells the payer they sign from their own wallet", () => {
    assert.match(shortcode, /sign and send from your own wallet/);
    assert.match(ghost, /sign and send from your own wallet/);
    assert.doesNotMatch(shortcode, /gateway|processor|x402/i);
    assert.doesNotMatch(ghost, /gateway|processor|x402/i);
  });

  it("keeps the Ghost embed as a self-contained HTML card", () => {
    assert.match(ghost, /href="https:\/\/send21\.io\/pay\/REPLACE_ME"/);
    assert.match(ghost, /--send21-accent: #f7931a/i);
  });
});
