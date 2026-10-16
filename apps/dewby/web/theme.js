// Runs before first paint. Light is the default; dark is opt-in (Settings).
// Turns window.BRAND (brand.js) into CSS custom properties, so rebranding is one file.
(function () {
  var B = window.BRAND || {};
  var t = null;
  try { t = localStorage.getItem((B.storagePrefix || "app") + ".theme"); } catch (e) { /* private mode */ }
  var theme = t === "dark" ? "dark" : "light";
  var root = document.documentElement;
  root.dataset.theme = theme;
  var css = "";
  function block(sel, pal, prefix) {
    if (!pal) return;
    css += sel + "{";
    for (var k in pal) css += "--" + prefix + k + ":" + pal[k] + ";";
    css += "}";
  }
  block(':root,[data-theme="light"]', B.light, "");
  block('[data-theme="dark"]', B.dark, "");
  block(":root", B.forcedDark, "fd-");
  var s = document.createElement("style");
  s.id = "brand-vars";
  s.textContent = css;
  document.head.appendChild(s);
  // Declare exactly one scheme so browser forced-dark modes leave the page alone where they can.
  var m = document.querySelector('meta[name="color-scheme"]');
  if (m) m.setAttribute("content", theme + " only");
  var c = document.querySelector('meta[name="theme-color"]');
  if (c && B[theme]) c.setAttribute("content", B[theme].bg);
  if (B.name) document.title = B.name + " · testnet";
})();
