// Runs before first paint: dark is the default, light is opt-in (Settings or the header toggle).
(function () {
  var t = null;
  try { t = localStorage.getItem("pair.theme"); } catch (e) { /* private mode */ }
  document.documentElement.dataset.theme = t === "light" ? "light" : "dark";
})();
