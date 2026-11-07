// Applies the saved theme before first paint. A classic blocking script in a file, not inline in
// index.html, because the server's Content-Security-Policy allows no inline scripts.
try {
  const savedTheme = localStorage.getItem("fot-theme");
  const theme =
    savedTheme === "light" || savedTheme === "dark" || savedTheme === "system"
      ? savedTheme
      : "system";
  document.documentElement.classList.toggle(
    "dark",
    theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
} catch {
  document.documentElement.classList.toggle(
    "dark",
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
}
