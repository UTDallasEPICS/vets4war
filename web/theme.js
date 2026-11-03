/* theme.js: light / dark toggle for the staffing console.
   Loaded in <head> (not deferred) so the saved theme is applied before first
   paint and the page never flashes the wrong colours. Light is the default;
   the choice is remembered per browser in localStorage. */
(function () {
  "use strict";

  const STORAGE_KEY = "v4w-theme";
  const THEMES = ["light", "dark"];
  const DEFAULT_THEME = "light";
  const root = document.documentElement;

  function readSaved() {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      return THEMES.includes(saved) ? saved : DEFAULT_THEME;
    } catch (_) {
      return DEFAULT_THEME; // storage blocked (private window): fall back quietly to light
    }
  }

  function save(theme) {
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch (_) { /* not persisted; still applied for this visit */ }
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
  }

  function syncButton(button, theme) {
    const isDark = theme === "dark";
    button.setAttribute("aria-pressed", String(isDark));
    button.setAttribute("title", isDark ? "Switch to light mode" : "Switch to dark mode");
    button.querySelector(".theme-label").textContent = isDark ? "Light" : "Dark";
  }

  apply(readSaved());

  document.addEventListener("DOMContentLoaded", function () {
    const button = document.getElementById("themeToggle");
    if (!button) return;
    syncButton(button, root.getAttribute("data-theme"));
    button.addEventListener("click", function () {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next);
      save(next);
      syncButton(button, next);
    });
  });
})();
