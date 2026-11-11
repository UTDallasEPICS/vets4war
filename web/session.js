/* Session controls on the main page: the Sign out button.
 *
 * The button is shown only when the server says sign-in is on (it is off on
 * a developer's own machine). Signing out asks the server to clear the
 * session cookie, then goes to the sign-in page (only once the server has
 * confirmed; a failed sign-out says so on the button). Loaded by index.html after
 * app.js; app.js itself sends the browser to /login.html when the API
 * answers 401 (session expired).
 */
(function () {
  "use strict";
  const LOGIN_PAGE = "/login.html";
  const button = document.getElementById("signOut");
  if (!button) return;

  async function showIfSignedIn() {
    try {
      const response = await fetch("/api/session", { credentials: "same-origin" });
      if (!response.ok) return;
      const body = await response.json();
      button.hidden = body.auth_required !== true;
    } catch (_) { /* offline or server down: leave the button hidden */ }
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    let signedOut = false;
    try {
      const response = await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      signedOut = response.ok;
    } catch (_) { /* network failure: handled below */ }
    // Only leave when the server confirmed it cleared the session; otherwise the
    // person would believe they were signed out while the cookie still worked.
    if (signedOut) { window.location.assign(LOGIN_PAGE); return; }
    button.disabled = false;
    button.textContent = "Sign out failed, try again";
  });

  showIfSignedIn();
})();
