/* Auth0-gated administration preview. Only Auth0 receives authentication calls.
 * Backend authorization, validation, imports, reports, and training remain
 * unconnected; never treat local selection checks as workbook validation.
 */
"use strict";

(() => {
  const get = (id) => document.getElementById(id);
  const workbook = get("workbook");
  const uploadMonth = get("uploadMonth");
  const reportMonth = get("reportMonth");
  const status = get("fileStatus");
  const check = get("checkFile");
  const clear = get("clearFile");
  const dropzone = get("dropzone");
  const maxBytes = 10 * 1024 * 1024;
  let selectedFile = null;

  // Calendar inputs use the operator's local month, with no UTC conversion.
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  uploadMonth.value = currentMonth;
  reportMonth.value = currentMonth;

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle("error", error);
  }

  function selectionError(file) {
    if (!/\.xlsx$/i.test(file.name)) return "Choose an .xlsx workbook. Other file formats are not supported by this preview.";
    if (file.size === 0) return "The selected file is empty. Choose a nonempty .xlsx workbook.";
    if (file.size > maxBytes) return "The selected file exceeds the 10 MB preview limit.";
    return null;
  }

  function syncButtons() {
    check.disabled = !selectedFile || !/^\d{4}-\d{2}$/.test(uploadMonth.value) || !uploadMonth.checkValidity();
    clear.disabled = !selectedFile && !workbook.value;
  }

  function selectFiles(files) {
    selectedFile = null;
    if (files.length !== 1) {
      workbook.value = "";
      message(files.length ? "Choose exactly one workbook at a time." : "No file selected. Nothing has been uploaded.", files.length > 0);
      syncButtons();
      return;
    }
    const file = files[0];
    const error = selectionError(file);
    if (error) {
      workbook.value = "";
      message(error, true);
    } else {
      selectedFile = file;
      message(`${file.name} · ${(file.size / 1024).toFixed(1)} KB selected locally. Workbook validation has not run.`);
    }
    syncButtons();
  }

  workbook.addEventListener("change", () => selectFiles(workbook.files));
  uploadMonth.addEventListener("input", () => {
    syncButtons();
    if (selectedFile) message("Reporting month changed. Check the file selection again; workbook contents remain unvalidated.");
  });
  check.addEventListener("click", () => {
    if (!selectedFile || check.disabled) return;
    const error = selectionError(selectedFile);
    if (error) { message(error, true); return; }
    message(`Local selection checks passed for ${uploadMonth.value}: .xlsx extension and file size only. Workbook contents, row dates, and duplicates have NOT been validated. Nothing was uploaded.`);
  });
  clear.addEventListener("click", () => {
    selectedFile = null;
    workbook.value = "";
    message("File cleared. Nothing has been uploaded or stored.");
    syncButtons();
  });

  // Dropping files never reads their contents or sends them to a server.
  let dragDepth = 0;
  dropzone.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add("dragging");
  });
  dropzone.addEventListener("dragover", (event) => event.preventDefault());
  dropzone.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove("dragging");
  });
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove("dragging");
    workbook.value = "";
    selectFiles(event.dataTransfer.files);
  });
  // Prevent accidental browser navigation if a file misses the drop target.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  function updateReport() {
    const month = reportMonth.value;
    get("reportMonthLabel").textContent = month || "Select a month";
    get("reportStatus").textContent = month
      ? `No report is connected for ${month}. All accuracy values are placeholders; no request was sent.`
      : "Select a reporting month. Monthly reports are not connected.";
  }
  reportMonth.addEventListener("input", updateReport);
  syncButtons();
  updateReport();

  // Public SPA configuration, not credentials. Never add a client secret here.
  const authConfig = {
    domain: "dev-f1eoazec4c5dukjs.us.auth0.com",
    clientId: "OrI6PaDntfNRXjZ0xYFjukTKgZr8qWwN",
    cacheLocation: "memory",
    useRefreshTokens: false,
    authorizationParams: {
      audience: "https://api.vets4warriors.admin",
      scope: "openid profile email",
      redirect_uri: `${window.location.origin}/admin.html`,
    },
  };
  const login = get("login");
  const logout = get("logout");
  const authStatus = get("authStatus");
  const content = get("adminContent");
  const gate = get("authGate");
  const email = get("userEmail");
  let client = null;

  function hideContent() {
    content.hidden = true;
    gate.hidden = false;
    email.hidden = true;
    email.textContent = "";
  }

  function authMessage(text) {
    // Never display SDK errors, callback parameters, profiles, or tokens.
    authStatus.textContent = text;
  }

  function clearCallbackParameters() {
    const url = new URL(window.location.href);
    for (const key of ["code", "state", "error", "error_description", "error_uri", "iss", "session_state"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
  }

  login.addEventListener("click", async () => {
    if (!client || login.disabled) return;
    login.disabled = true;
    authMessage("Redirecting to Auth0…");
    try {
      // The official SPA SDK handles PKCE, state, and nonce verification.
      await client.loginWithRedirect();
    } catch (_) {
      hideContent();
      login.disabled = false;
      authMessage("Sign-in could not start. Please try again.");
    }
  });

  logout.addEventListener("click", async () => {
    hideContent();
    selectedFile = null;
    workbook.value = "";
    syncButtons();
    message("File cleared. Nothing has been uploaded or stored.");
    login.disabled = true;
    logout.disabled = true;
    authMessage("Signing out…");
    try {
      await client.logout({ logoutParams: { returnTo: authConfig.authorizationParams.redirect_uri } });
    } catch (_) {
      // Keep content hidden even when Auth0 logout cannot complete.
      logout.disabled = false;
      login.disabled = false;
      authMessage("Sign-out could not complete. Try logging out again to end the Auth0 session.");
    }
  });

  async function initializeAuth() {
    hideContent();
    const params = new URLSearchParams(window.location.search);
    const callback = params.has("code") || params.has("error") || params.has("state");
    try {
      if (!window.auth0 || typeof window.auth0.Auth0Client !== "function") {
        authMessage("Auth0 could not load. Check your connection and reload this page.");
        return;
      }
      client = new window.auth0.Auth0Client(authConfig);
      if (callback) {
        try {
          await client.handleRedirectCallback();
        } finally {
          clearCallbackParameters();
        }
      } else {
        await client.checkSession();
      }
      if (!(await client.isAuthenticated())) {
        authMessage("Sign in to view the admin interface.");
        return;
      }
      logout.hidden = false;
      // Request a token for the configured API. It stays in the SDK's memory
      // cache: never log, render, persist, or send it to an unconnected backend.
      await client.getTokenSilently();
      const user = await client.getUser();
      email.textContent = user && typeof user.email === "string" ? user.email : "Signed in (email unavailable)";
      email.hidden = false;
      gate.hidden = true;
      content.hidden = false;
    } catch (_) {
      hideContent();
      authMessage("Sign-in or API token request failed. Try logging in again; if this continues, ask an administrator to check Auth0 configuration.");
    } finally {
      // Clean even an error callback received while the SDK was unavailable.
      if (callback) clearCallbackParameters();
      login.disabled = !client;
    }
  }

  initializeAuth();
})();
