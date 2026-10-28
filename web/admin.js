"use strict";
(() => {
  const $ = id => document.getElementById(id);
  let csrf = "", batch = null, profile = null, history = [];
  function notice(text, error = false) {
    $("notice").hidden = false;
    $("notice").className = "notice " + (error ? "error" : "success");
    $("notice").textContent = text;
  }
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { "X-CSRF-Token": csrf, ...options.headers } });
    if (response.status === 401) { location.assign("/login?next=admin"); throw new Error("Please sign in again."); }
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Check the form and try again.");
    return data;
  }
  function textCell(row, text) { const td = document.createElement("td"); td.textContent = text; row.append(td); return td; }
  function renderReport(report) {
    const panel = $("report-content"); panel.replaceChildren(); $("report-title").textContent = "Monthly report · " + report.month;
    const stats = document.createElement("div"); stats.className = "stats";
    const actual = report.actuals;
    for (const [label, value] of [["Calls received", actual.calls], ["Answered", actual.answered], ["Abandoned", actual.abandoned], ["Abandonment rate", actual.abandonment_rate === null ? "—" : (actual.abandonment_rate * 100).toFixed(1) + "%"], ["Mean handle time (seconds)", actual.mean_handle_sec === null ? "—" : actual.mean_handle_sec.toFixed(1)]]) {
      const cell = document.createElement("div"), number = document.createElement("strong"); number.textContent = typeof value === "number" ? value.toLocaleString() : value; cell.append(number, label); stats.append(cell);
    }
    panel.append(stats);
    const status = document.createElement("p"); status.className = "notice"; status.textContent = "Model training: " + (report.training?.status || "pending") + ". These call totals are actual results for the uploaded month."; panel.append(status);
    const table = document.createElement("table"), head = table.createTHead().insertRow();
    for (const label of ["Date", "Calls", "Abandoned"]) { const th = document.createElement("th"); th.scope = "col"; th.textContent = label; head.append(th); }
    const body = table.createTBody();
    for (const day of report.daily) { const row = body.insertRow(); textCell(row, day.date); textCell(row, day.calls.toLocaleString()); textCell(row, day.abandoned.toLocaleString()); }
    panel.append(table);
    for (const note of report.notes) { const p = document.createElement("p"); p.className = "muted"; p.textContent = note; panel.append(p); }
    $("report-panel").hidden = false; $("report-panel").scrollIntoView({ behavior: "smooth" });
  }
  async function loadHistory() {
    const data = await api("/api/admin/uploads"); history = data.uploads;
    $("model").textContent = "Active model: " + data.active_model_version;
    $("history").replaceChildren(); $("empty").hidden = history.length > 0;
    const selected = $("replace").value;
    $("replace").replaceChildren(new Option("Add a new month", ""));
    for (const item of history) {
      const month = item.month.slice(0, 7), row = document.createElement("tr");
      textCell(row, month + " · " + item.uploader + " · " + new Date(item.created_at).toLocaleString());
      textCell(row, item.status + " · " + item.summary.summary.total_rows + " rows");
      textCell(row, (item.training_status || "—") + (item.job_state === "failed" ? " · Processing failed" : ""));
      const actions = textCell(row, "");
      if (item.report_id) {
        const view = document.createElement("button"); view.type = "button"; view.textContent = "View report";
        view.onclick = async () => { try { renderReport(await api("/api/admin/reports/" + item.report_id)); } catch (error) { notice(error.message, true); } };
        const download = document.createElement("a"); download.href = "/api/admin/reports/" + item.report_id + "?format=csv"; download.textContent = "CSV";
        actions.append(view, document.createTextNode(" "), download);
      } else { actions.textContent = item.report_status || "—"; }
      if (item.status === "imported" && (item.job_state === "failed" || item.training_status === "rejected")) {
        const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry processing";
        retry.onclick = async () => { retry.disabled = true; try { await api("/api/admin/jobs/" + item.job_id + "/retry", { method: "POST" }); await loadHistory(); notice("Processing queued again."); } catch (error) { notice(error.message, true); retry.disabled = false; } };
        actions.append(retry);
      }
      $("history").append(row);
      if (item.status === "imported" && month === $("month").value) $("replace").add(new Option("Replace current " + month + " import", item.id));
    }
    if ([...$("replace").options].some(option => option.value === selected)) $("replace").value = selected;
  }
  $("month").onchange = () => { batch = null; $("preview").hidden = true; loadHistory().catch(error => notice(error.message, true)); };
  $("file").onchange = () => { batch = null; $("preview").hidden = true; };
  $("upload-form").onsubmit = async event => {
    event.preventDefault(); const file = $("file").files[0]; if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx") || file.size > 25 * 1024 * 1024) { notice("Choose an .xlsx file no larger than 25 MB.", true); return; }
    $("validate").disabled = true; $("file").disabled = true; $("month").disabled = true; batch = null; $("preview").hidden = true;
    try {
      batch = await api("/api/admin/uploads?month=" + encodeURIComponent($("month").value), { method: "POST", headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: file });
      const validation = batch.validation; $("preview").hidden = false; $("counts").replaceChildren();
      for (const [key, value] of Object.entries(validation.summary)) { const cell = document.createElement("div"), number = document.createElement("strong"); number.textContent = value; cell.append(number, key.replaceAll("_", " ")); $("counts").append(cell); }
      $("validation-details").textContent = JSON.stringify(validation, null, 2);
      $("validation-message").textContent = validation.ok ? "The records passed validation. Confirm the source count and full-month coverage below." : "Resolve the validation errors in the source file and upload it again.";
      $("import-form").hidden = !validation.ok || batch.status !== "validated";
      $("import").disabled = !validation.contract_confirmed;
      $("expected").value = ""; $("complete").checked = false;
      notice(validation.contract_confirmed ? "Validation finished. Review the results." : "Validation finished. Imports remain disabled until the historical export contract is confirmed.");
      await loadHistory();
    } catch (error) { notice(error.message, true); } finally { $("validate").disabled = false; $("file").disabled = false; $("month").disabled = false; }
  };
  $("import-form").onsubmit = async event => {
    event.preventDefault(); if (!batch) return; $("import").disabled = true;
    try {
      await api("/api/admin/uploads/" + batch.id + "/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm_complete_month: $("complete").checked, expected_rows: Number($("expected").value), replace_batch_id: $("replace").value || null }) });
      $("preview").hidden = true; batch = null; notice("Month imported. Retraining and the monthly report are queued; their progress appears below."); await loadHistory();
    } catch (error) { notice(error.message, true); $("import").disabled = false; }
  };
  $("logout").onclick = async () => { try { await api("/auth/logout", { method: "POST" }); location.assign("/login"); } catch (error) { notice(error.message, true); } };
  async function init() {
    const session = await api("/api/session"); if (!session.user) { location.assign("/login?next=admin"); return; }
    csrf = session.csrf; $("account").textContent = session.user.email;
    const config = await api("/api/admin/contract"); profile = config.contract;
    $("contract").textContent = !config.configured ? config.detail : profile.confirmed && profile.confirmed_by.trim() ? "The saved export format is confirmed. Upload the same format each month." : "The historical export format still needs confirmation. You can validate files; database imports are disabled.";
    $("contract-details").textContent = profile ? JSON.stringify(profile, null, 2) : "Ask your administrator to configure the historical export format.";
    $("validate").disabled = !config.configured; await loadHistory();
    setInterval(() => { if (!document.hidden) loadHistory().catch(error => notice(error.message, true)); }, 15000);
  }
  init().catch(error => notice(error.message, true));
})();
