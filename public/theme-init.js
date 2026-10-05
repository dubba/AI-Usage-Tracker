// Runs before first paint (loaded synchronously from index.html) so the saved theme is applied
// without a flash. Keep the storage key and resolution rules in sync with src/shared/lib/theme.ts.
(function () {
  var pref = "dark";
  try {
    var saved = window.localStorage.getItem("ai-usage-tracker:theme");
    if (saved === "dark" || saved === "light" || saved === "system") pref = saved;
  } catch (e) {}
  var light =
    pref === "light" ||
    (pref === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
})();
