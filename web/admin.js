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
  let authorized = false, canImport = false, canTrain = false, busy = false, generation = 0;
  const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
  const MAX_REPLACE_DAYS = 366;
  const MAX_DAYS_LISTED = 10;
  let history = [];
  let historyLoaded = false, historyLoading = false, historyRequest = 0;
  const requests = new Set();
  let restoring = false;
  // Nonsecret loop guard only: tokens remain exclusively in SDK memory.
  let accuracyReport = null, accuracyRequest = 0;
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
      batch.validation.nothing_to_import || replacing > MAX_REPLACE_DAYS || !get("confirmImport").checked ||
      !Number.isInteger(count) || count < 1 || count !== batch.validation.summary.total_rows;
    get("importFile").textContent = replacing ? `Replace ${replacing} day${replacing === 1 ? "" : "s"} & import` : "Import";
    get("clearFile").disabled = busy || !selectedFile;
    get("workbook").disabled = busy;
    get("refreshHistory").disabled = busy || !authorized || historyLoading;
    get("refreshModelHealth").disabled = busy || !authorized;
    get("refreshReports").disabled = busy || !authorized;
    get("loadAccuracy").disabled = busy || !authorized || !get("reportMonth").value || !get("reportMonth").checkValidity();
    get("loadTraining").disabled = busy || !authorized;
    get("requestTraining").disabled = busy || !authorized || !canTrain || !get("trainCutoff").value || !get("trainConfirm").checked;
    get("downloadAccuracy").disabled = !authorized || !accuracyReport;
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
    get("validationIssues").replaceChildren();
    get("dayReviewRows").replaceChildren(); get("dayReview").hidden = true; get("dayReview").open = false;
    message("importStatus",""); syncButtons();
  }
  function hideContent() {
    authorized = false; canImport = false; canTrain = false; get("adminContent").hidden = true;
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
    updateReport(); renderModelHealth();
    get("trainRuns").replaceChildren(); get("trainConfirm").checked = false;
    message("trainStatus","Select Refresh runs to check retraining history.");
    message("reportListStatus","");
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
  async function actionRefreshHistory(version) {
    try { await refreshHistory(); }
    catch (error) {
      if (!current(version)) return;
      if (error.authCode || error.status === 401 || error.status === 403) throw error;
      message("historyStatus",error.message);
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
    const detail = get("dayReviewRows");
    detail.replaceChildren();
    get("dayReview").hidden = different.length === 0 || different.length > MAX_REPLACE_DAYS;
    for (const day of different.slice(0,MAX_REPLACE_DAYS)) {
      const row = document.createElement("tr");
      for (const value of [day.day,day.rows,day.existing_rows]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      detail.append(row);
    }
    if (different.length > MAX_REPLACE_DAYS) issue(`Split this workbook into smaller ranges before importing more than ${MAX_REPLACE_DAYS} replacement days.`);
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
      message("fileStatus",`${selectedFile.name}: batch ${batch.id} (${batch.status}). This request did not change calls.`);
      const replacing = conflictDays();
      message("importStatus",batch.status !== "validated" ? "This batch cannot be imported. Select a fresh workbook." :
        batch.validation.nothing_to_import ? "Every day in this file is already loaded. Nothing to import." :
        replacing.length ? `${replacing.length} day${replacing.length === 1 ? "" : "s"} already hold different calls (${listDays(replacing)}). Importing replaces exactly those days. Verify the source row count and confirm.` :
        "Verify the source row count and confirm before importing.");
      await actionRefreshHistory(version);
    });
  });
  get("stageFile").addEventListener("click",() => {
    if (get("stageFile").disabled) return;
    return action("fileStatus",async version => {
      resetValidation(); uploadStatus("Checking without staging...");
      const report = await api("/api/admin/validate",{method:"POST",body:workbookBody()});
      if (!current(version)) return;
      showReport(report); uploadStatus(report.ok ? "Checked, not staged" : "Validation failed");
      message("fileStatus",report.ok ? `${selectedFile.name}: checks passed. Nothing stored. Use Validate upload to stage this file.` : "Validation failed. Correct the workbook and try again.");
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
        message("importStatus",`Import completed: ${result.inserted_rows} calls added, ${result.deleted_rows} removed (${result.replaced_days.length} day(s) replaced), ${result.skipped_days.length} day(s) were already loaded. Staffing data refreshes on the next request. Retraining is separate.`);
      } catch (error) {
        if (current(version) && error.status === 409) {
          await actionRefreshHistory(version);
          uploadStatus("Import conflict");
          message("importStatus",`${error.message} Validate the file again to see the current state.`); return;
        }
        throw error;
      }
      await Promise.all([actionRefreshHistory(version), refreshModelHealth(version)]);
    });
  });
  get("refreshHistory").addEventListener("click",() => action("historyStatus",refreshHistory));
  function renderModelHealth(model = null, status = "Not loaded") {
    message("healthStatus",status);
    for (const id of ["healthMae","healthRmse","healthBias"]) message(id,"—");
    const gate = model?.historical_backtest;
    const observed = model?.data_through;
    message("healthData", observed ? `Latest observed call date: ${observed}. Coverage requires separate verification.` :
      model?.data_status === "empty" ? "No calls are stored." : "Latest observed call date unavailable.");
    const value = gate?.metrics.daily_mape_1_14;
    message("healthBacktest", Number.isFinite(value) ?
      `Saved rolling-origin training gate: passed, ${gate.origins} origins (${gate.first_origin} to ${gate.last_origin}); daily MAPE at 1-14 days: ${value.toFixed(2)}%.` :
      "Saved training backtest unavailable.");
    const report = model?.evaluation;
    const period = report?.evaluation_period;
    if (model) {
      message("healthStatus",report ? `Evaluation: ${report.status}` : "No matching retrospective report");
    }
    message("healthPeriod",period ? `Evaluation period: ${period.start} to ${period.end} · ${period.timezone}` : "Evaluation period: not available");
    message("healthModel",model ? `${model.name} ? ${model.version}. Trained ${model.trained_at}. Data through ${model.train_end} (${model.data_age_days} days old).` : "Model identity unavailable");
    message("healthCompleteness",report && report.completeness.verified ? "Data completeness: verified for the evaluated period." : "Data completeness: not verified");
    if (report && ["success","partial"].includes(report.status) && report.completeness.verified && report.metrics) {
      for (const [id,key] of [["healthMae","hourly_mae"],["healthRmse","hourly_rmse"],["healthBias","signed_bias"]]) {
        message(id,report.metrics[key].toLocaleString(undefined,{maximumFractionDigits:1}));
      }
    }
    const list = get("healthWarnings"); list.replaceChildren();
    for (const warning of report ? report.warnings : []) {
      const li = document.createElement("li"); li.textContent = warning; list.append(li);
    }
  }
  async function refreshModelHealth(version) {
    renderModelHealth(null,"Loading");
    try {
      const model = await api("/api/admin/model-health");
      if (current(version)) renderModelHealth(model);
    } catch (error) {
      if (!current(version)) return;
      if (error.authCode || error.status === 401 || error.status === 403) throw error;
      renderModelHealth(null,"Unavailable");
    }
  }
  get("refreshModelHealth").addEventListener("click",() => action("healthStatus",refreshModelHealth));
  async function refreshTraining(version) {
    message("trainStatus","Loading runs...");
    const runs = await api("/api/admin/retraining");
    if (!current(version)) return;
    const list = get("trainRuns");
    list.replaceChildren();
    for (const run of runs) {
      const line = document.createElement("li"), link = document.createElement("a");
      link.href = run.html_url;
      link.textContent = run.display_title;
      line.append(link,document.createTextNode(` ? ${run.conclusion || run.status} ? ${new Date(run.created_at).toLocaleString()}`));
      list.append(line);
    }
    message("trainStatus",runs.length ? "Open a run on GitHub for job details or failure logs." : "No retraining runs.");
  }
  for (const id of ["trainCutoff","trainConfirm"]) get(id).addEventListener("input",syncButtons);
  get("loadTraining").addEventListener("click",() => action("trainStatus",refreshTraining));
  get("requestTraining").addEventListener("click",() => action("trainStatus",async version => {
    if (!canTrain || !get("trainConfirm").checked) return;
    message("trainStatus","Requesting retraining...");
    const run = await api("/api/admin/retraining", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({cutoff:get("trainCutoff").value, complete_history_confirmed:true})});
    if (!current(version)) return;
    get("trainConfirm").checked = false;
    message("trainStatus",`GitHub accepted run ${run.id}. Refresh runs to check its progress.`);
  }));
  function renderComparisons() {
    const rows = get("comparisonRows"), grain = get("reportGrain").value;
    rows.replaceChildren();
    const points = accuracyReport?.[grain] || [];
    message("comparisonStatus",accuracyReport && !points.length ? "Comparison details unavailable for this report." : "");
    for (const point of points) {
      const row = document.createElement("tr");
      for (const value of [point.day || point.hour.replace("T"," "),point.actual,
                           point.predicted.toLocaleString(undefined,{maximumFractionDigits:1})]) {
        const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
      }
      rows.append(row);
    }
  }
  get("reportGrain").addEventListener("input",renderComparisons);
  function updateReport() {
    accuracyRequest++; accuracyReport = null;
    message("accuracyStatus","Not loaded");
    message("reportStatus",authorized ? "Choose a month and select View report." : "Sign in to view reports.");
    for (const id of ["accuracyActual","accuracyPredicted","accuracyError"]) message(id,"—");
    for (const id of ["accuracyPeriod","accuracyModel","accuracyDirection","accuracyDetail"]) message(id,"");
    get("accuracyWarnings").replaceChildren(); renderComparisons(); syncButtons();
  }
  get("refreshReports").addEventListener("click",() => action("reportListStatus",async version => {
    message("reportListStatus","Loading available months...");
    const reportList = await api("/api/admin/reports");
    if (!current(version)) return;
    message("reportListStatus",reportList.months.length ?
      `Available months: ${reportList.months.join(", ")}.` : "No completed months have reports.");
  }));
  get("reportMonth").addEventListener("input",updateReport);
  get("loadAccuracy").addEventListener("click",() => {
    if (get("loadAccuracy").disabled) return;
    return action("reportStatus",async version => {
      updateReport();
      const request = accuracyRequest, month = get("reportMonth").value;
      message("accuracyStatus","Loading"); message("reportStatus","Loading report...");
      let report;
      try { report = await api(`/api/admin/reports/${encodeURIComponent(month)}`); }
      catch (error) {
        if (!current(version)) return;
        // A month change invalidates report data, not an authorization denial.
        // Let action() clear the session even if this report is now stale.
        if (error.authCode || error.status === 401 || error.status === 403) throw error;
        if (request !== accuracyRequest) return;
        message("accuracyStatus","Unavailable");
        if (error.status === 404) { message("reportStatus","No report has been prepared for this month yet."); return; }
        throw error;
      }
      if (!current(version) || request !== accuracyRequest) return;
      accuracyReport = report;
      const labels = {success:"Ready",partial:"Partial month",incomplete:"Data not verified",no_data:"No eligible data",error:"Report failed"};
      message("accuracyStatus",labels[report.status] || "Unavailable");
      renderComparisons();
      message("reportStatus",report.status === "success" ? "Report ready." : report.status === "partial" ? "Only part of this month was evaluated. These are not full-month results." : "Accuracy values are unavailable. Review the warnings below.");
      const period = report.evaluation_period;
      message("accuracyPeriod",period ? `${period.start} to ${period.end} · ${period.timezone}` : "No evaluation period available.");
      const model = report.model || {};
      const modelId = model.model_sha256 ? `Report model SHA-256: ${model.model_sha256}` : "Report model version unavailable";
      message("accuracyModel",model.train_end ? `${modelId}. Trained through ${model.train_end.slice(0,10)}.` : `${modelId}.`);
      if (["success","partial"].includes(report.status) && report.completeness.verified && report.metrics) {
        const m = report.metrics, number = n => n.toLocaleString(undefined,{maximumFractionDigits:1});
        message("accuracyActual",number(m.actual_calls)); message("accuracyPredicted",number(m.predicted_calls));
        message("accuracyError",`${number(m.hourly_mae)} calls/hour`);
        message("accuracyDirection",m.signed_bias > 0 ? `The model overestimated calls by an average of ${number(m.signed_bias)} calls/hour.` :
          m.signed_bias < 0 ? `The model underestimated calls by an average of ${number(-m.signed_bias)} calls/hour.` : "Predicted and actual totals matched. Individual hours may still differ.");
        message("accuracyDetail",`Average daily error: ${number(m.daily_total_mae)} calls/day. Larger-error measure (RMSE): ${number(m.hourly_rmse)} calls/hour.`);
      }
      for (const warning of report.warnings) {
        const li = document.createElement("li"); li.textContent = warning; get("accuracyWarnings").append(li);
      }
    });
  });
  get("downloadAccuracy").addEventListener("click",() => {
    if (!authorized || !accuracyReport || get("downloadAccuracy").disabled) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(accuracyReport,null,2)],{type:"application/json"}));
    const link = document.createElement("a"); link.href = url;
    link.download = `accuracy-${accuracyReport.reporting_month}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  });
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
      canImport = identity.permissions.includes("import:calls");
      canTrain = identity.permissions.includes("trigger:retraining"); authorized = true;
      message("apiStatus","Admin API access verified."); message("userEmail",user && user.email || "Signed in");
      get("userEmail").hidden = false; get("logout").hidden = false;
      get("authGate").hidden = true; get("adminContent").hidden = false; syncButtons();
      const results = await Promise.allSettled([refreshHistory(), refreshModelHealth(version)]);
      if (!current(version)) return;
      for (const result of results) {
        if (result.status !== "rejected") continue;
        const error = result.reason;
        if (error.authCode || error.status === 401 || error.status === 403) throw error;
        message("historyStatus",error.message);
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
