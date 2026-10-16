// Fuzzing the two inputs people type (amount and name) plus the link and URL guards.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FINAL, MAX_AMOUNT, REQUEST_TTL_MS, addressGroups, canMove, cleanText, encodeCard, fiatDecimals, parseAmount,
  safeHref, sanitizeAmountInput, statusWord, timeLeft, validColor, validId,
} from "../web/lib/core.js";

// Small seeded PRNG so a failure is reproducible.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const ALPHABET = ["0", "1", "5", "9", ".", ",", " ", "-", "+", "e", "E", "x", "\u00A0", "\u202F", "١", "٫", "€", "$", "\u200B", "\u202E", "a", "'", "_", "∞", "NaN"];
function randomAmount(r) { let s = ""; const n = Math.floor(r() * 12); for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(r() * ALPHABET.length)]; return s; }
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/;

test("parseAmount: known good and bad inputs", () => {
  const ok = (s, f, v) => assert.deepEqual(parseAmount(s, f), { ok: true, value: v }, `${s} ${f}`);
  ok("12", "SEK", 12); ok("12.5", "SEK", 12.5); ok("12,50", "EUR", 12.5); ok("0.01", "USD", 0.01); ok("12.", "USD", 12);
  ok("1 000", "SEK", 1000); ok(" 7 ", "SEK", 7); ok("500", "JPY", 500); ok(10000, "USD", 10000); ok(12.5, "USD", 12.5);
  const bad = (s, f, re) => { const r = parseAmount(s, f); assert.equal(r.ok, false, `${JSON.stringify(s)} should fail`); if (re) assert.match(r.error, re); };
  bad("1e3", "USD", /Numbers only/); bad("0x10", "USD"); bad("-5", "USD"); bad("+5", "USD"); bad("1,000.50", "USD"); bad("1.2.3", "USD");
  bad("12.345", "USD", /Max 2 decimals/); bad("500.5", "JPY", /No decimals in JPY/); bad("0", "USD", /More than 0/); bad("0.00", "USD", /More than 0/);
  bad("10000.01", "USD", /Max 10 000 USD/); bad("Infinity", "USD"); bad(NaN, "USD"); bad(Infinity, "USD"); bad(1e21, "USD"); bad(1e-7, "USD");
  bad("١٢", "USD"); bad("12\u200B", "USD"); bad(null, "USD"); bad(undefined, "USD"); bad({}, "USD"); bad([], "USD"); bad(true, "USD");
  assert.equal(parseAmount("", "USD").empty, true);
});

test("parseAmount fuzz: never throws, and every accepted value is finite, positive, capped and correctly rounded", () => {
  const r = rng(21);
  const fiats = ["USD", "SEK", "EUR", "JPY", "KRW", "GBP", "XXX"];
  let accepted = 0;
  for (let i = 0; i < 20000; i++) {
    const fiat = fiats[i % fiats.length];
    const input = i % 5 === 0 ? (r() - 0.3) * 10 ** Math.floor(r() * 8) : randomAmount(r);
    const out = parseAmount(input, fiat);
    if (!out.ok) { assert.equal(typeof out.error, "string"); assert.ok(out.error.length < 40, out.error); continue; }
    accepted++;
    assert.ok(Number.isFinite(out.value) && out.value > 0 && out.value <= MAX_AMOUNT, `${input} -> ${out.value}`);
    const dec = fiatDecimals(fiat);
    assert.equal(Math.round(out.value * 10 ** dec) / 10 ** dec, out.value, `${input} keeps ${dec} decimals`);
  }
  assert.ok(accepted > 100, `the fuzz also hits valid amounts (${accepted})`);
});

test("sanitizeAmountInput: whatever is typed, the field shows only digits and one separator", () => {
  const r = rng(7);
  for (let i = 0; i < 20000; i++) {
    const fiat = i % 3 ? "SEK" : "JPY";
    const out = sanitizeAmountInput(randomAmount(r) + randomAmount(r), fiat);
    assert.match(out, fiat === "JPY" ? /^\d{0,5}$/ : /^\d{0,5}([.,]\d{0,2})?$/, out);
  }
  assert.equal(sanitizeAmountInput("0012.345", "SEK"), "12.34");
  assert.equal(sanitizeAmountInput("12,5,5", "EUR"), "12,55");
  assert.equal(sanitizeAmountInput("99.9", "JPY"), "99");
  assert.equal(sanitizeAmountInput("1234567", "USD"), "12345");
});

test("cleanText fuzz: no invisible or bidi characters survive, length is capped, output is stable", () => {
  const r = rng(99);
  const pool = ["A", "ö", "李", "😀", "👩‍👩‍👧", " ", "\t", "\n", "\u0000", "\u0007", "\u007F", "\u0085", "\u00AD", "\u061C", "\u200B", "\u200D", "\u200E", "\u202A", "\u202E", "\u2066", "\u2069", "\uFEFF", "<", ">", "&", '"', "'", "e\u0301"];
  for (let i = 0; i < 20000; i++) {
    let s = ""; const n = Math.floor(r() * 60);
    for (let j = 0; j < n; j++) s += pool[Math.floor(r() * pool.length)];
    const max = 1 + Math.floor(r() * 80);
    const out = cleanText(s, max);
    assert.doesNotMatch(out, UNSAFE, JSON.stringify(out));
    assert.ok([...out].length <= max);
    assert.equal(out, out.trim());
    assert.doesNotMatch(out, /\s{2}/);
    assert.equal(cleanText(out, max), out, "idempotent");
  }
  assert.equal(cleanText("\u202Eyaps"), "yaps", "a right-to-left override cannot flip a name");
  assert.equal(cleanText("Sa\u200Bm"), "Sam", "a zero-width space cannot make a look-alike");
  assert.equal(cleanText("e\u0301"), "é", "NFC");
  assert.equal(cleanText("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>", "markup stays text; the UI escapes it");
  assert.equal(cleanText(null), "");
});

test("safeHref: only wallet schemes and https become links", () => {
  for (const ok of ["solana:7xKX?amount=1", "bitcoin:tb1qxyz?amount=0.1", "ethereum:0xabc@11155111", "lightning:lnbc1", "https://send21.io/x"]) assert.equal(safeHref(ok), ok);
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>", "http://x.y", "vbscript:x", "solana:a b", 'solana:a"onclick=x', "//evil.example", "", null, undefined])
    assert.equal(safeHref(bad), null, String(bad));
});

test("ids, colors, address groups, status words, time left and the state machine", () => {
  assert.ok(validId("abc_DEF-123")); assert.ok(!validId("abc")); assert.ok(!validId("abc<script>")); assert.ok(!validId(123456));
  assert.ok(validColor("#34D8A6")); assert.ok(!validColor("red")); assert.ok(!validColor("#fff;background:url(x)"));
  assert.deepEqual(addressGroups("7xKXtg2CW8"), ["7xKX", "tg2C", "W8"]);
  assert.equal(statusWord("awaiting", true), "Waiting"); assert.equal(statusWord("awaiting", false), "To pay");
  assert.equal(statusWord("review"), "Mismatch"); assert.equal(statusWord("cancelled"), "Cancelled");
  const now = 1_000_000_000_000;
  assert.equal(timeLeft(now + REQUEST_TTL_MS, now), "3 d"); assert.equal(timeLeft(now + 5 * 3600_000, now), "5 h");
  assert.equal(timeLeft(now + 90_000, now), "2 min"); assert.equal(timeLeft(now - 1, now), null); assert.equal(timeLeft("x", now), null);
  for (const f of FINAL) for (const to of ["awaiting", "seen", "review", "paid", "expired", "cancelled"]) assert.equal(canMove(f, to), false, `${f} -> ${to}`);
  assert.ok(encodeCard({ a: 1 }).length > 0);
});
