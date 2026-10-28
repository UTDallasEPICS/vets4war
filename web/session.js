"use strict";
(async () => {
  try {
    const response = await fetch("/api/session");
    if (!response.ok) return;
    const session = await response.json(), bar = document.querySelector(".topbar");
    if (!bar) return;
    const freshness = document.createElement("span"); freshness.id = "dataFreshness"; freshness.className = "badge"; freshness.setAttribute("aria-live", "polite"); bar.append(freshness);
    if (!session.user) return;
    if (session.user.role === "admin") {
      const portal = document.createElement("a"); portal.href = "/admin"; portal.className = "pill"; portal.textContent = "Monthly data"; bar.append(portal);
    }
    const logout = document.createElement("button"); logout.type = "button"; logout.className = "pill"; logout.textContent = "Sign out";
    logout.onclick = async () => {
      const result = await fetch("/auth/logout", { method: "POST", headers: { "X-CSRF-Token": session.csrf } });
      if (result.ok || result.status === 401) location.assign("/login");
    };
    bar.append(logout);
  } catch (_) { /* The existing forecast error handles unavailable servers. */ }
})();
