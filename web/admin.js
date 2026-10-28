/* Standalone administration preview. No API calls, workbook parsing, or storage.
 * Backend validation, imports, reports, training, and Auth0 are intentionally
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
})();
