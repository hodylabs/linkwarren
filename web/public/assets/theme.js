// Applies the saved theme before the first paint. A file, not inline, because the CSP allows script-src self only.
// No saved choice (or "system") leaves data-theme unset, so styles.css follows the OS. Keep in step with src/theme.ts.
try {
  var t = localStorage.getItem("lw.theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {
  // storage blocked: follow the OS
}
