// dewby brand config: the ONE file to edit when you rebrand this app.
// Classic script (not a module) so it runs before first paint, and so the Node
// server and scripts/brand.js can read it too. After editing, run `npm run brand`
// to regenerate the PWA manifest, the PNG icons and the <title> in index.html.
window.BRAND = {
  name: "dewby",                       // UI name, wordmark text fallback, wallet memo prefix
  tagline: "Pay friends back. Fresh.",
  description: "Ask friends for money, split the bill, pay back. You sign in your own wallet. Testnet example.",
  storagePrefix: "dewby",              // localStorage/sessionStorage keys; keep apps on one origin apart
  poweredBy: true,                     // tiny "powered by send21" line in Settings > About
  siteUrl: "https://send21io.github.io/send21-examples/dewby/", // where it's hosted: share card URLs (og:*)
  shareTitle: "dewby: pay friends back, split bills, show a QR",
  codeUrl: "https://github.com/send21io/send21-examples/tree/main/apps/dewby",

  // Light is the default theme. Every color the UI uses comes from here (CSS custom properties).
  light: {
    bg: "#F5FAF3",        // soft off-white
    surface: "#FFFFFF",
    ink: "#0D2B26",       // deep pine: text, dark fills
    muted: "#4D6A63",
    line: "rgba(13, 43, 38, .10)",
    mint: "#34D8A6",      // primary
    lime: "#C6F25E",      // secondary
    sea: "#A8EBD9",       // seafoam
    pop: "#FF5A8A",       // punchy accent
    link: "#0B7356",      // text-safe mint on bg (5.4:1)
    ok: "#0E7A54", warn: "#835500", bad: "#C2264B",
  },
  dark: {
    bg: "#0B1F1B", surface: "#12302A", ink: "#ECFFF7", muted: "#9DBDB4", line: "rgba(236, 255, 247, .12)",
    mint: "#34D8A6", lime: "#C6F25E", sea: "#A8EBD9", pop: "#FF6F99", link: "#5BE8BD",
    ok: "#6EE7B7", warn: "#FFD166", bad: "#FF8FA8",
  },
  // Friend avatars (ink text on top, so keep them light and bright).
  avatars: ["#34D8A6", "#C6F25E", "#FF8FB1", "#A8EBD9", "#FFD166", "#8FD8FF", "#C9B8FF", "#FFB38A"],
  // Browsers that force dark mode on every page (Samsung Internet's default) darken light fills and
  // ignore opt-outs. Then the app switches to this palette: dark fills, color carried by text, icons
  // and outlines, which those browsers leave alone.
  forcedDark: {
    bg: "#0A1C18", surface: "#10292A", fill: "#0F2A24", ink: "#ECFFF7", muted: "#A6C4BB",
    mint: "#5BE8BD", lime: "#D4FA7A", pop: "#FF7AA2", edge: "#5BE8BD",
  },
};
