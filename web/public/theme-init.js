// Applies the saved theme before first paint (no flash). Kept external for a strict CSP.
(function () {
  try {
    var pref = localStorage.getItem("gouvra.theme") || "system";
    var dark =
      pref === "dark" ||
      (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch (e) {
    document.documentElement.dataset.theme = "light";
  }
})();
