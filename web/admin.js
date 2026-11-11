/* Same-origin admin client. Access tokens stay in the SDK's memory cache. */
"use strict";
(() => {
  const get = id => document.getElementById(id);
  const redirectUri = `${window.location.origin}/admin.html`;
  // The tenant, application and API come from the server's settings
  // (GET /api/admin/config), so none of them is written into this file.
  async function loadConfig() {
    // 503 means the server has no Auth0 settings; anything else that fails
    // (no network, a cold start) is worth retrying.
    let response;
    try { response = await fetch("/api/admin/config", { headers: { Accept: "application/json" }, cache: "no-store" }); }
    catch (error) { throw Object.assign(new Error("Settings request failed"), { notConfigured: false }); }
    if (!response.ok) throw Object.assign(new Error("Settings request refused"), { notConfigured: response.status === 503 });
    const settings = await response.json();
    return {
      domain: settings.domain, clientId: settings.clientId,
      cacheLocation: "memory", useRefreshTokens: false,
      authorizationParams: { audience: settings.audience, scope: "openid profile email", redirect_uri: redirectUri },
    };
  }
  let client, selectedFile, batch;
  let authorized = false, canImport = false, busy = false, generation = 0;
  const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
  const MAX_DAYS_LISTED = 10;
  let history = [];
  let historyLoaded = false, historyLoading = false, historyRequest = 0;
  const requests = new Set();
  let restoring = false;
  // Nonsecret loop guard only: tokens remain exclusively in SDK memory.
  const recoveryKey = "v4w.admin.silent-recovery";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const year = Number(parts.find(p => p.type === "year").value);
  const month = Number(parts.find(p => p.type === "month").value);
  const previousMonth = `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2,"0")}`;
  get("reportMonth").value = previousMonth; get("reportMonth").max = previousMonth;
  const message = (id, text) => { get(id).textContent = text; };
  const current = version => version === generation;
  // The days of the staged file whose stored calls differ from the file's.
  // Importing replaces exactly these days, and only after the admin confirms.
  function conflictDays() {
    return batch && batch.validation.days ? batch.validation.days.filter(day => day.status === "conflict").map(day => day.day) : [];
  }
  function listDays(days) {
    const more = days.length - MAX_DAYS_LISTED;
    return days.slice(0,MAX_DAYS_LISTED).join(", ") + (more > 0 ? ` and ${more} more` : "");
  }
  function syncButtons() {
    get("checkFile").disabled = busy || !authorized || !canImport || !selectedFile;
    get("stageFile").disabled = busy || !authorized || !selectedFile;
    const count = Number(get("expectedRows").value), replacing = conflictDays().length;
    get("importFile").disabled = busy || !authorized || !canImport || !batch || batch.status !== "validated" ||
      batch.validation.nothing_to_import || !get("confirmImport").checked ||
      !Number.isInteger(count) || count < 1 || count !== batch.validation.summary.total_rows;
    get("importFile").textContent = replacing ? `Replace ${replacing} day${replacing === 1 ? "" : "s"} & import` : "Import";
    get("clearFile").disabled = busy || !selectedFile;
    get("workbook").disabled = busy;
    get("refreshHistory").disabled = busy || !authorized || historyLoading;
  }
  // What a batch covers: its days, or the month for batches staged before day ranges.
  function period(item) {
    if (item.first_day) return item.first_day === item.last_day ? item.first_day : `${item.first_day} to ${item.last_day}`;
    return item.month ? item.month.slice(0,7) : "—";
  }
  function uploadStatus(text, pending = true) {
    message("uploadStatus",text); get("uploadStatus").classList.toggle("pending",pending);
  }
  function resetValidation() {
    batch = null; get("confirmImport").checked = false; get("expectedRows").value = "";
    uploadStatus("Not validated");
    message("validationState","Not run"); message("validationCounts","— / — / —");
    get("validationIssues").replaceChildren(); message("importStatus",""); syncButtons();
  }
  function hideContent() {
    authorized = false; canImport = false; get("adminContent").hidden = true;
    get("logout").hidden = true;
    get("authGate").hidden = false; get("userEmail").hidden = true; message("userEmail",""); syncButtons();
  }
  function expireSession() {
    generation++;
    for (const controller of requests) controller.abort();
    hideContent(); selectedFile = null; get("workbook").value = "";
    message("apiStatus",""); get("login").hidden = false; get("retrySession").hidden = true;
    history = []; get("historyRows").replaceChildren(); resetValidation();
    historyLoaded = false; historyLoading = false;
    message("refreshHistory","Refresh history"); message("historyRefreshedAt","Not refreshed yet.");
  }
  function authError(error) {
    const code = error && error.error;
    const allowed = ["login_required", "consent_required", "interaction_required", "timeout", "network_error", "request_error"];
    const safeCode = allowed.includes(code) ? code : error && error.name === "TypeError" ? "network_error" : "unknown";
    const result = new Error("Session verification failed.");
    result.authCode = safeCode;
    return result;
  }
  function transient(error) {
    return ["timeout", "network_error", "request_error"].includes(error.authCode);
  }
  async function accessToken(version) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await client.getTokenSilently();
        if (!token) throw {error: "login_required"};
        return token;
      } catch (error) {
        const failure = authError(error);
        // Retry token acquisition only. Never automatically repeat an upload
        // or import whose transaction may already have completed.
        if (!current(version) || attempt || !transient(failure)) throw failure;
      }
    }
  }
  function showSessionFailure(error) {
    const interactive = ["login_required", "consent_required", "interaction_required"].includes(error.authCode) || error.status === 401;
    const denied = error.status === 403;
    message("authTitle", denied ? "Admin access denied" : interactive ? "Staff sign-in" : "Session check unavailable");
    message("authStatus", denied ? "Your account does not have the required admin permissions." :
      error.status === 401 ? "The admin API rejected the access token (401). Log in again to continue." :
      error.authCode === "login_required" ? "Sign in to continue." :
      interactive ? `Auth0 requires a sign-in or consent check (${error.authCode || "invalid_token"}). Use Log in to continue.` :
      error.authCode ? `Silent restoration could not complete (${error.authCode}). Retry the session check; this does not necessarily mean your session expired.` :
      "The admin API could not verify access. Retry the session check when the connection or service is available.");
    get("retrySession").hidden = interactive || denied;
    get("login").hidden = !interactive && !denied;
  }
  function clearRecovery() {
    try { window.sessionStorage.removeItem(recoveryKey); } catch (_) { /* Storage is optional. */ }
  }
  async function recoverTopLevel(error) {
    if (error.authCode !== "login_required") return;
    try {
      // A top-level prompt=none request can use the Auth0 session cookie when
      // the hidden iframe cannot. Allow one attempt, never a redirect loop.
      if (window.sessionStorage.getItem(recoveryKey)) return;
      window.sessionStorage.setItem(recoveryKey,"attempted");
    } catch (_) { return; } // No loop guard available: use explicit login.
    try { await client.loginWithRedirect({authorizationParams:{prompt:"none"}}); }
    catch (_) { showSessionFailure(error); }
  }
  async function api(path, options = {}) {
    const version = generation;
    const token = await accessToken(version);
    if (!current(version)) throw new Error("Request cancelled.");
    const controller = new AbortController(); requests.add(controller);
    try {
      const response = await fetch(path, { ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
        cache: "no-store", redirect: "error", signal: controller.signal });
      if (!current(version)) throw new Error("Request cancelled.");
      let body = null;
      try { body = await response.json(); } catch (_) { /* HTTP auth status still applies. */ }
      if (!current(version)) throw new Error("Request cancelled.");
      if (!response.ok) {
        const error = new Error(body && typeof body.detail === "string" ? body.detail : `Request failed (${response.status}).`);
        error.status = response.status; throw error;
      }
      if (body === null) throw new Error("Invalid API response.");
      return body;
    } catch (error) {
      if (error.status) throw error;
      const failure = new Error("The request could not complete. Check your connection and try again.");
      failure.apiFailure = true;
      throw failure;
    } finally { requests.delete(controller); }
  }
  async function refreshHistory() {
    const version = generation, request = ++historyRequest;
    historyLoading = true;
    message("refreshHistory","Refreshing..."); message("historyStatus","Loading upload history..."); syncButtons();
    try {
      const rows = await api("/api/admin/uploads");
      if (!current(version) || request !== historyRequest) return;
      // Compare response data without depending on JSON object key order.
      const canonical = value => Array.isArray(value) ? value.map(canonical) :
        value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
      const unchanged = historyLoaded && JSON.stringify(canonical(rows)) === JSON.stringify(canonical(history));
      history = rows; historyLoaded = true;
      const table = get("historyRows"); table.replaceChildren();
      for (const item of rows) {
        const row = document.createElement("tr");
        for (const value of [period(item),item.status,item.uploader,item.imported_by || "—",item.id]) {
          const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
        }
        table.append(row);
      }
      const count = rows.length ? `${rows.length} uploads shown.` : "No uploads yet.";
      message("historyStatus",unchanged ? `No changes. ${count}` : count);
      message("historyRefreshedAt",`Last refreshed: ${new Date().toLocaleString(undefined,{timeZoneName:"short"})}`);
    } finally {
      if (current(version) && request === historyRequest) {
        historyLoading = false; message("refreshHistory","Refresh history"); syncButtons();
      }
    }
  }
  function showReport(report) {
    const summary = report.summary;
    message("validationState",report.ok ? "Passed" : "Failed");
    message("validationCounts",summary.days === undefined ? "— / — / —" : `${summary.new_days} / ${summary.identical_days} / ${summary.conflict_days}`);
    const list = get("validationIssues"); list.replaceChildren();
    function issue(text) { const li = document.createElement("li"); li.textContent = text; list.append(li); }
    if (summary.days !== undefined) issue(`${summary.total_rows} calls, ${summary.first_day} to ${summary.last_day}.`);
    for (const error of report.file_errors || []) issue(error.message);
    const different = (report.days || []).filter(day => day.status === "conflict");
    for (const day of different.slice(0,MAX_DAYS_LISTED)) issue(`${day.day}: the file has ${day.rows} calls, the database has ${day.existing_rows} and they differ.`);
    if (different.length > MAX_DAYS_LISTED) issue(`${different.length - MAX_DAYS_LISTED} more days differ.`);
    if (report.nothing_to_import) issue("Every day in this file is already loaded with the same calls. Nothing to import.");
    for (const warning of report.warnings || []) issue(warning);
  }
  function selectFiles(files) {
    if (busy) return;
    selectedFile = null; resetValidation();
    const file = files.length === 1 ? files[0] : null;
    if (!file || !/\.xlsx$/i.test(file.name) || !file.size || file.size > MAX_UPLOAD_BYTES) {
      get("workbook").value = ""; message("fileStatus","Choose exactly one nonempty .xlsx workbook, up to 4 MB.");
    } else { selectedFile = file; message("fileStatus",canImport ? `${file.name} selected. Validate upload to stage a batch for review.` : `${file.name} selected. Use Check without staging; uploading requires import permission.`); }
    syncButtons();
  }
  async function action(id, operation) {
    if (busy || !authorized) return;
    busy = true; syncButtons(); const version = generation;
    try { await operation(version); }
    catch (error) {
      if (current(version)) {
        if (error.authCode || error.status === 401 || error.status === 403) {
          expireSession(); showSessionFailure(error);
        } else {
          message(id,error.message);
          if (id === "fileStatus") uploadStatus("Validation unavailable");
          if (id === "importStatus") uploadStatus(error.status ? "Import rejected" : "Import status unknown");
        }
      }
    }
    finally { busy = false; syncButtons(); }
  }
  function workbookBody() {
    const form = new FormData(); form.append("file",selectedFile);
    return form;
  }
  get("workbook").addEventListener("change",() => selectFiles(get("workbook").files));
  get("clearFile").addEventListener("click",() => { selectedFile = null; get("workbook").value = ""; resetValidation(); message("fileStatus","File cleared."); });
  for (const name of ["dragenter","dragover"]) get("dropzone").addEventListener(name,event => event.preventDefault());
  get("dropzone").addEventListener("drop",event => { event.preventDefault(); selectFiles(event.dataTransfer.files); });
  for (const name of ["dragover","drop"]) window.addEventListener(name,event => event.preventDefault());
  for (const id of ["expectedRows","confirmImport"]) get(id).addEventListener("input",syncButtons);
  get("checkFile").addEventListener("click",() => {
    if (get("checkFile").disabled) return;
    return action("fileStatus",async version => {
      resetValidation();
      uploadStatus("Validating upload...");
      const result = await api("/api/admin/uploads",{method:"POST",body:workbookBody()});
      if (!current(version)) return;
      batch = result; showReport(batch.validation);
      uploadStatus(batch.status === "validated" ? "Validated batch" : batch.status === "invalid" ? "Validation failed" : `Batch ${batch.status}`,batch.status !== "validated");
      message("fileStatus",`Batch ${batch.id}: ${batch.status}. This request did not change calls.`);
      const replacing = conflictDays();
      message("importStatus",batch.status !== "validated" ? "This batch cannot be imported. Select a fresh workbook." :
        batch.validation.nothing_to_import ? "Every day in this file is already loaded. Nothing to import." :
        replacing.length ? `${replacing.length} day${replacing.length === 1 ? "" : "s"} already hold different calls (${listDays(replacing)}). Importing replaces exactly those days. Verify the source row count and confirm.` :
        "Verify the source row count and confirm before importing.");
      await refreshHistory();
    });
  });
  get("stageFile").addEventListener("click",() => {
    if (get("stageFile").disabled) return;
    return action("fileStatus",async version => {
      resetValidation(); uploadStatus("Checking without staging...");
      const report = await api("/api/admin/validate",{method:"POST",body:workbookBody()});
      if (!current(version)) return;
      showReport(report); uploadStatus(report.ok ? "Checked, not staged" : "Validation failed");
      message("fileStatus",report.ok ? "Checks passed. Nothing stored. Use Validate upload to stage this file for import." : "Validation failed. Correct the workbook and try again.");
    });
  });
  get("importFile").addEventListener("click",() => {
    if (get("importFile").disabled) return;
    return action("importStatus",async version => {
      const body = {expected_rows:Number(get("expectedRows").value),replace_days:conflictDays()};
      get("confirmImport").checked = false;
      try {
        const result = await api(`/api/admin/uploads/${encodeURIComponent(batch.id)}/import`,{
          method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
        if (!current(version)) return;
        batch = {...batch,status:result.status};
        uploadStatus("Imported",false);
        message("importStatus",`Import completed: ${result.inserted_rows} calls added, ${result.deleted_rows} removed (${result.replaced_days.length} day(s) replaced), ${result.skipped_days.length} day(s) were already loaded. Retraining remains manual. Call-derived caches update after an API restart.`);
      } catch (error) {
        if (current(version) && error.status === 409) {
          await refreshHistory();
          uploadStatus("Import conflict");
          message("importStatus",`${error.message} Validate the file again to see the current state.`); return;
        }
        throw error;
      }
      await refreshHistory();
    });
  });
  get("refreshHistory").addEventListener("click",() => action("historyStatus",refreshHistory));
  function updateReport() {
    const value = get("reportMonth").value; message("reportMonthLabel",value || "Select a month");
    message("reportStatus",value ? `No report is connected for ${value}. Accuracy values remain unavailable.` : "Select a reporting month. Monthly reports are not connected.");
  }
  get("reportMonth").addEventListener("input",updateReport);
  get("login").addEventListener("click",async () => {
    if (!client || get("login").disabled) return;
    get("login").disabled = true;
    clearRecovery();
    try { await client.loginWithRedirect(); }
    catch (_) { message("authStatus","Sign-in could not start. Please try again."); get("login").disabled = false; }
  });
  get("logout").addEventListener("click",async () => {
    clearRecovery();
    expireSession(); message("apiStatus",""); get("logout").disabled = true; get("login").disabled = true;
    try { await client.logout({logoutParams:{returnTo:redirectUri}}); }
    catch (_) { message("authStatus","Sign-out could not complete. Try logging out again to end the Auth0 session."); get("logout").hidden = false; get("logout").disabled = false; get("login").disabled = false; }
  });
  function clearCallback() {
    const url = new URL(window.location.href);
    for (const key of ["code","state","error","error_description","error_uri","iss","session_state"]) url.searchParams.delete(key);
    window.history.replaceState({},document.title,url.pathname+url.search+url.hash);
  }
  async function initializeAuth() {
    if (restoring) return;
    restoring = true;
    get("retrySession").disabled = true; get("retrySession").hidden = true;
    let configFailed = false;
    get("login").disabled = true;
    hideContent(); const params = new URLSearchParams(window.location.search);
    const callback = params.has("code") || params.has("error") || params.has("state"), version = generation;
    try {
      if (!window.auth0 || typeof window.auth0.Auth0Client !== "function") { message("authStatus","Auth0 could not load. Check your connection and reload."); return; }
      if (!client) {
        let config;
        try { config = await loadConfig(); }
        catch (error) {
          configFailed = true;
          message("authStatus", error.notConfigured
            ? "Admin sign-in is not configured on this server. Tell the site owner."
            : "Could not reach the server to start sign-in. Check your connection and retry.");
          return;
        }
        client = new window.auth0.Auth0Client(config);
      }
      if (callback) { try { await client.handleRedirectCallback(); } finally { clearCallback(); } }
      // Direct silent acquisition attempts restoration even without the optional
      // checkSession marker cookie. Interactive fallback requires a user click.
      const identity = await api("/api/admin/me"), user = await client.getUser();
      if (!current(version)) return;
      clearRecovery();
      canImport = identity.permissions.includes("import:calls"); authorized = true;
      message("apiStatus","Admin API access verified."); message("userEmail",user && user.email || "Signed in");
      get("userEmail").hidden = false; get("logout").hidden = false;
      get("authGate").hidden = true; get("adminContent").hidden = false; syncButtons();
      try { await refreshHistory(); }
      catch (error) {
        if (!current(version)) return;
        if (error.authCode || error.status === 401 || error.status === 403) {
          expireSession(); showSessionFailure(error);
        } else message("historyStatus",error.message);
      }
    } catch (error) {
      if (current(version)) {
        expireSession();
        const failure = error.authCode || error.status || error.apiFailure ? error : authError(error);
        showSessionFailure(failure);
        // Never retry an error callback or a backend authorization denial.
        if (!callback) await recoverTopLevel(failure);
      }
    } finally {
      if (callback) clearCallback();
      restoring = false;
      get("login").disabled = !client; get("retrySession").disabled = !client && !configFailed;
      // Without settings there is no client yet, so Retry is the only way forward short of a reload.
      if (configFailed) get("retrySession").hidden = false;
    }
  }
  get("retrySession").addEventListener("click",initializeAuth);
  updateReport(); syncButtons(); initializeAuth();
})();
