// Runs before first paint: dark is the default, light is opt-in (Settings or the header toggle).
(function () {
  var t = null;
  try { t = localStorage.getItem("pair.theme"); } catch (e) { /* private mode */ }
  var theme = t === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  // Declare exactly one scheme so browser forced-dark modes (Samsung Internet,
  // Chrome auto dark theme) leave the page alone.
  var m = document.querySelector('meta[name="color-scheme"]');
  if (m) m.setAttribute("content", theme + " only");
})();
