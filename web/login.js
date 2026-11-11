/* Sign-in page for the staffing console. Sends the password to /api/login;
 * the server answers by setting an HttpOnly session cookie, which this
 * script never sees. See api/site_auth.py for how the session works. */
(function () {
  "use strict";
  const THEME_KEY = "v4w-theme";
  const SECONDS_PER_MINUTE = 60;
  const BUSY_SECONDS = 10;           // a wait this short means the server is busy, not a lockout
  const HOME = "/";
  const form = document.getElementById("form");
  const input = document.getElementById("password");
  const reveal = document.getElementById("reveal");
  const submit = document.getElementById("submit");
  const error = document.getElementById("error");

  // Follow the theme chosen on the main page, if any.
  try {
    if (window.localStorage.getItem(THEME_KEY) === "dark") document.documentElement.setAttribute("data-theme", "dark");
  } catch (_) { /* storage blocked: stay on the light default */ }

  function show(message) {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
  }
  function clear() {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
  }
  function setBusy(busy) {
    submit.disabled = busy;
    submit.textContent = busy ? "Signing in" : "Sign in";
  }
  function waitMessage(response) {
    const seconds = Number(response.headers.get("Retry-After"));
    if (Number.isFinite(seconds) && seconds > 0 && seconds <= BUSY_SECONDS) return "Sign-in is busy. Try again in a few seconds.";
    const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / SECONDS_PER_MINUTE) : null;
    return minutes === null ? "Too many wrong passwords. Try again later."
      : `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  function messageFor(response) {
    if (response.status === 401) return "Wrong password. Check it and try again.";
    if (response.status === 429) return waitMessage(response);
    if (response.status === 503) return "Sign-in is not set up on this server. Ask whoever runs it to set the password.";
    return `Sign-in failed (error ${response.status}). Try again.`;
  }

  reveal.addEventListener("click", () => {
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    reveal.textContent = showing ? "Show" : "Hide";
    reveal.setAttribute("aria-pressed", String(!showing));
    input.focus();
  });
  input.addEventListener("input", clear);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (input.value === "") { show("Enter the password."); input.focus(); return; }
    clear();
    setBusy(true);
    try {
      const response = await fetch("/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ password: input.value }),
      });
      if (response.ok) { window.location.replace(HOME); return; }
      show(messageFor(response));
      input.select();
    } catch (_) {
      show("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  });
})();
