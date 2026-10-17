/* DOM layer of the staffing console. All numbers come from web/logic.js
 * (and web/erlang.js underneath); this file only reads controls, renders,
 * and talks to the API. Read logic.js first if you want to know where a
 * number comes from.
 *
 * The queue model is fixed to Erlang A with the caller patience measured
 * from the data, and handle time uses the default recency weighting: those
 * are no longer controls on the page.
 *
 * Data flow:
 *   date range / holidays change   -> fetch /api/forecast (network)
 *   efficiency / service level     -> recompute() in the browser (no network)
 *   hours shown                    -> rebuild the grid columns (no network)
 *   planned value edited           -> store + re-judge that shift (no network)
 */
(function () {
  "use strict";
  const L = V4WUI;
  const HOURS = L.HOURS, SHIFTS = L.SHIFTS, MAX = L.MAX_STAFF_PER_SHIFT, SPH = L.SECONDS_PER_HOUR;
  const QUEUE_MODEL = "erlang_a";
  const RECENCY = "weighted";
  const DEBOUNCE_MS = 60;
  const CHANGED_VISIBLE_MS = 2500;
  const DEFAULT_HORIZON_DAYS = 30;
  const SECONDS_PER_MINUTE = 60;
  const MAJOR_HOURS = new Set([0, 6, 12, 18]);
  const SL_MIN = 80, SL_MAX = 95, SL_STANDARD = 90, SL_CURRENT = [80, 85];
  const DEEP_LEVEL = 0.6;            // above this heat level the numeral turns white
  const THUMB_PX = 20;
  const UNDEF = "-";
  const PNG = { cell: 34, row: 30, date: 120, roster: 52, pad: 20, head: 64,
    lo: "#f3f6fd", hi: "#3b82f6", bg: "#ffffff", ink: "#0f172a", mute: "#64748b", amber: "#f59e0b", amberBg: "#fef3c7",
    red: "#dc2626", rosterBg: "#f6f8fc", green: "#047857", maxMix: 0.78 };

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("start"), end: $("end"), eff: $("eff"), effNum: $("effNum"), sl: $("sl"), slNum: $("slNum"), slTrack: $("slTrack"), tsec: $("tsec"),
    hFrom: $("hFrom"), hTo: $("hTo"), hoursTrack: $("hoursTrack"), hoursVal: $("hoursVal"),
    holidays: $("holidays"), changed: $("changed"),
    head: $("gridHead"), rows: $("rows"), scroll: $("gridScroll"), gridNote: $("gridNote"),
    sheet: $("sheet"), sheetTitle: $("sheetTitle"), sheetBody: $("sheetBody"), sheetClose: $("sheetClose"),
    summary: $("summary"), caveat: $("caveat"), sourceBadge: $("sourceBadge"), exportPng: $("exportPng"), exportCsv: $("exportCsv"),
    error: $("error"), holidayNote: $("holidayNote"),
  };

  // ---- state ----
  let cache = null;          // { key, hours, days, window, params, source, coverage }
  let computed = [];         // hours with staffing for the current controls
  let judged = [];           // days with shift roll-up + planned verdicts
  let hourIndex = new Map(), cellIndex = new Map();
  let scale = { lo: 0, hi: 0, levelOf: () => 0 };
  let view = null;           // null | { type: "hour", key } | { type: "day", date } | { type: "selection" }
  let selection = null;
  let changedTimer = null;
  const store = L.createPlannedStore(safeStorage());

  function safeStorage() { try { return window.localStorage; } catch (_) { return null; } }

  // ---- helpers ----
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad2 = (n) => String(n).padStart(2, "0");
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function localDate(s) { return new Date(s + "T00:00:00"); }
  function shortDate(s) { return localDate(s).toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
  function longDate(s) { return localDate(s).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }); }
  function dayLabel(s) { return localDate(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  function formatDuration(sec) {
    const minutes = Math.floor(sec / SECONDS_PER_MINUTE + 0.5);
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `${h.toLocaleString()}h ${m}m` : `${m}m`;
  }
  function targetSec() { const v = Number(el.tsec.value); return Number.isFinite(v) && v >= 0 ? Math.min(v, Number(el.tsec.max)) : Number(el.tsec.defaultValue); }
  function patienceSec() { return cache ? cache.params.patience_sec : null; }
  function controls() {
    return { efficiency: Number(el.effNum.value) / 100, targetPct: Number(el.slNum.value) / 100, targetSec: targetSec(), patienceSec: patienceSec() };
  }
  function rangeKey() { return `${el.start.value}|${el.end.value}|${el.holidays.checked}`; }
  function hourRange() { const a = Number(el.hFrom.value), b = Number(el.hTo.value); return [Math.min(a, b), Math.max(a, b)]; }
  function inHours(h) { const [a, b] = hourRange(); return h >= a && h <= b; }
  // Visible columns, tour by tour: hour cells, then the tour's roster cell.
  // A tour with no visible hours drops out, roster included.
  function visibleTours() { return SHIFTS.map((spec) => ({ spec, hours: spec.core.filter(inHours) })).filter((t) => t.hours.length > 0); }
  function verdictShort(v) { return { "understaffed": "Under", "on target": "On target", "overstaffed": "Over", "exceeds capacity": "Exceeds cap" }[v] || v; }
  const verdictClass = (v) => (v ? `v-${v.replace(/ /g, "-")}` : "");

  // ---- controls: sync + feedback ----
  function clampInt(v, lo, hi, fallback) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; }
  function fraction(range) { return (range.value - range.min) / (range.max - range.min); }
  function setFill(range) { range.style.setProperty("--fill", (fraction(range) * 100).toFixed(1) + "%"); }
  // Thumb centre along a track, so marks line up with where the thumb sits.
  const along = (f) => `calc(${THUMB_PX / 2}px + (100% - ${THUMB_PX}px) * ${f.toFixed(4)})`;
  function renderHours() {
    const [a, b] = hourRange();
    el.hoursTrack.style.setProperty("--a", along(a / 23));
    el.hoursTrack.style.setProperty("--b", along(b / 23));
    el.hoursVal.textContent = a === 0 && b === 23 ? "All day" : `${pad2(a)}:00 to ${pad2(b)}:59`;
  }
  function renderControlFeedback() { setFill(el.eff); setFill(el.sl); renderHours(); }
  function flashChanged(n) {
    el.changed.textContent = n > 0 ? `${n} hour${n === 1 ? "" : "s"} changed` : "No hours changed";
    el.changed.classList.remove("quiet");
    clearTimeout(changedTimer);
    changedTimer = setTimeout(() => el.changed.classList.add("quiet"), CHANGED_VISIBLE_MS);
  }

  // ---- fetch ----
  async function fetchJson(url, init) {
    const res = await fetch(url, init);
    if (!res.ok) {
      let detail = res.statusText;
      try { const body = await res.json(); detail = Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join("; ") : (body.detail || detail); } catch (_) {}
      throw new Error(`${res.status}: ${detail}`);
    }
    return res.json();
  }
  function serverParams() {
    const c = controls();
    return new URLSearchParams({ start: el.start.value, end: el.end.value, queue_model: QUEUE_MODEL, recency: RECENCY,
      include_holidays: String(el.holidays.checked), efficiency: c.efficiency.toFixed(2), target_pct: c.targetPct.toFixed(2), target_sec: String(c.targetSec) });
  }
  let inflight = 0;
  async function refresh() {
    const k = rangeKey();
    if (cache && cache.key === k) { recompute(); return; }
    const id = ++inflight;
    document.body.classList.add("is-loading");
    try {
      const data = await fetchJson("/api/forecast?" + serverParams());
      if (id !== inflight) return;
      cache = { key: k, hours: data.hours.map((h) => ({ date: h.date, hour: h.hour, predicted_calls: h.predicted_calls, aht_sec: h.aht_sec })),
        days: data.days, window: data.window, params: data.params, source: data.data_source, coverage: data.holiday_coverage };
      el.error.hidden = true;
      renderSourceBadge(cache.source);
      el.holidayNote.hidden = !cache.coverage.message;
      el.holidayNote.textContent = cache.coverage.message || "";
      selection = null;
      if (view && view.type === "day" && !cache.days.some((d) => d.date === view.date)) closeSheet();
      if (view && view.type !== "day") closeSheet();
      buildGrid(cache.days);
      computed = [];
      recompute();
    } catch (err) {
      if (id !== inflight) return;
      cache = null;
      el.error.hidden = false;
      el.error.textContent = `The forecast did not load (${err.message}). Check that the server is running and V4W_DATABASE_URL is set, then change a date to retry.`;
      el.rows.innerHTML = "";
    } finally {
      if (id === inflight) document.body.classList.remove("is-loading");
    }
  }
  function renderSourceBadge(src) {
    if (!src) return;
    el.sourceBadge.className = `badge src-${src.kind}`;
    el.sourceBadge.textContent = src.kind === "unlabeled" ? src.label : `${src.label}, ${shortDate(src.start)} ${src.start.slice(0, 4)} to ${shortDate(src.end)} ${src.end.slice(0, 4)}`;
  }

  // ---- grid skeleton (per range and per hours shown) ----
  function buildGrid(days) {
    const tours = visibleTours();
    el.head.innerHTML =
      `<tr><th class="date" rowspan="2"></th>${tours.map((t) => `<th class="group" colspan="${t.hours.length + 1}">${t.spec.name}<small>${t.spec.span}</small></th>`).join("")}</tr>` +
      `<tr>${tours.map((t) => t.hours.map((h) => `<th class="hh${MAJOR_HOURS.has(h) ? " major" : ""}" data-h="${h}">${pad2(h)}</th>`).join("") +
        `<th class="roster" title="The tour's busiest hour sets the number to roster. Type your own to compare.">Roster</th>`).join("")}</tr>`;
    const today = isoDate(new Date());
    el.rows.innerHTML = days.map((day) => {
      const cls = [day.is_weekend ? "weekend" : "", day.date === today ? "today" : "", day.holiday ? "holiday" : "",
        view && view.type === "day" && view.date === day.date ? "picked" : ""].join(" ").trim();
      const dt = localDate(day.date);
      const meta = day.holiday ? esc(day.holiday) : (day.date === today ? "Today" : "");
      const cells = tours.map((t) =>
        t.hours.map((h) => `<td class="h${MAJOR_HOURS.has(h) ? " major" : ""}" data-k="${L.key(day.date, h)}" data-d="${day.date}" data-h="${h}" tabindex="0"></td>`).join("") +
        `<td class="roster" data-plan="${L.shiftKey(day.date, t.spec.name)}"><input type="number" name="planned" min="0" max="99" step="1" inputmode="numeric" autocomplete="off" aria-label="Planned staff, ${t.spec.name}, ${day.date}" data-d="${day.date}" data-s="${t.spec.name}"><span class="verdict"></span></td>`
      ).join("");
      return `<tr class="${cls}" data-d="${day.date}"><td class="date"><button type="button" class="date-btn" data-day="${day.date}"${day.holiday ? ` title="${esc(day.holiday)}"` : ""}>` +
        `<div class="d">${dt.toLocaleDateString(undefined, { weekday: "short" })}<span>${dt.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span></div><div class="meta">${meta}</div></button></td>${cells}</tr>`;
    }).join("");
    cellIndex = new Map([...el.rows.querySelectorAll("td.h[data-k]")].map((td) => [td.dataset.k, td]));
    el.gridNote.textContent = "Tours overlap by 30 minutes. The overlap hour counts toward the roster of both tours it touches, and toward the calls of the tour it starts. " +
      "Roster shows the tour's busiest hour; type a number to plan your own, or clear it to follow the recommendation.";
  }

  // ---- recompute (no network) ----
  function recompute() {
    if (!cache) return;
    const c = controls();
    const next = L.computeHours(cache.hours, c);
    const changed = L.diffCells(computed, next);
    const first = computed.length === 0;
    computed = next;
    hourIndex = new Map(computed.map((h) => [L.key(h.date, h.hour), h]));
    judged = L.judgeRoster(L.rollupShifts(cache.days, computed), store, c);
    repaint();
    renderSummary(c);
    renderSheet();
    renderControlFeedback();
    if (!first) flashChanged(changed);
  }
  function repaint() { patchCells(computed); patchShifts(judged); renderLegend(); }

  function patchCells(hours) {
    scale = L.discreteScale(hours.map((h) => h.staff_to_schedule));
    const peaks = new Set(L.peakHours(hours));
    el.head.querySelectorAll("th.hh").forEach((th) => {
      const peak = peaks.has(Number(th.dataset.h));
      th.classList.toggle("peak", peak);
      th.title = peak ? "One of the four busiest hours in this window" : "";
    });
    const activeKey = view && view.type === "hour" ? view.key : null;
    hours.forEach((h) => {
      const td = cellIndex.get(L.key(h.date, h.hour));
      if (!td) return;
      const staff = h.staff_to_schedule;
      const lvl = h.cap_state === "under" ? scale.levelOf(staff) : 0;
      td.style.setProperty("--lvl", lvl.toFixed(3));
      td.className = `h cap-${h.cap_state}${MAJOR_HOURS.has(h.hour) ? " major" : ""}${lvl > DEEP_LEVEL ? " deep" : ""}${h.implausible ? " implausible" : ""}` +
        `${inSelection(h) ? " sel" : ""}${activeKey === L.key(h.date, h.hour) ? " active" : ""}`;
      td.innerHTML = h.cap_state === "over"
        ? `<span class="n">${staff}</span><span class="cl">${pct(h.service_level_if_capped)} at ${MAX}</span>`
        : `<span class="n">${staff === null ? UNDEF : staff}</span>`;
      td.setAttribute("aria-label", `${h.date} ${pad2(h.hour)}:00, ${staff === null ? "undefined" : staff} people to schedule`);
    });
  }

  function patchShifts(days) {
    days.forEach((day) => {
      SHIFTS.forEach((spec) => {
        const s = day.shifts[spec.name], p = day.planned[spec.name];
        const cell = el.rows.querySelector(`td.roster[data-plan="${L.shiftKey(day.date, spec.name)}"]`);
        if (!cell) return;
        const input = cell.querySelector("input"), tag = cell.querySelector(".verdict");
        cell.className = `roster cap-${L.capState(s.staff_needed)}${p.is_own ? " own" : ""}`;
        if (document.activeElement !== input) input.value = p.is_own ? p.planned : "";
        input.placeholder = s.staff_needed === null ? UNDEF : s.staff_needed;
        if (p.verdict === null) { tag.className = "verdict"; tag.textContent = UNDEF; cell.title = ""; return; }
        if (p.is_own) {
          tag.className = `verdict ${verdictClass(p.verdict)}`;
          tag.textContent = `${verdictShort(p.verdict)}${p.delta ? ` ${p.delta > 0 ? "+" : ""}${p.delta}` : ""}`;
        } else {
          tag.className = "verdict";
          tag.textContent = `Peak · ${pct(p.service_level)}`;
        }
        cell.title = `${p.is_own ? `${p.verdict}: ${p.planned} planned vs ${p.recommended} recommended` : `${p.recommended} recommended (the tour's busiest hour)`}. ` +
          `${p.effective_agents} on inbound after efficiency; the weakest hour answers ${pct(p.service_level, 1)} in time` +
          `${p.abandon_share === null ? "" : ` and loses ${pct(p.abandon_share, 1)} of callers`}.`;
      });
    });
  }

  function renderLegend() { $("legendRange").textContent = scale.lo === scale.hi ? `${scale.lo}` : `${scale.lo} to ${scale.hi}`; }

  // ---- summary ----
  function renderSummary(c) {
    const s = L.summarize(computed);
    const fewer = L.abandonedOneFewer(computed, c);
    const stat = (cls, k, v, d) => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`;
    const span = `${shortDate(cache.window.start)} to ${shortDate(cache.window.end)}`;
    const lead = s.abandoned === null
      ? stat("lead", "Expected hang-ups", UNDEF, "Undefined at 0% efficiency")
      : stat("lead", "Expected hang-ups", `${Math.round(s.abandoned).toLocaleString()}<small>${s.calls > 0 ? pct(s.abandoned / s.calls, 1) + " of calls" : ""}</small>`,
        `Before a peer answers, at the recommended staffing, ${span}`);
    const talkHours = s.talkSec / SPH;
    let story;
    if (s.personHours === null) story = "Scheduled person-hours are undefined at 0% efficiency.";
    else {
      const gap = s.personHours - talkHours, ratio = talkHours > 0 ? s.personHours / talkHours : null;
      story = `Scheduled hours exceed expected talk time by <b>${formatDuration(Math.max(0, gap) * SPH)}</b>${ratio ? ` (${ratio.toFixed(1)}×)` : ""}. ` +
        `That gap is the efficiency setting (${el.effNum.value}% of a shift on inbound) plus the queue slack needed to answer ${el.slNum.value}% within ${c.targetSec} s.` +
        (fewer !== null && s.abandoned !== null ? ` With one fewer person every hour, hang-ups would rise from <b>${Math.round(s.abandoned).toLocaleString()}</b> to <b>${Math.round(fewer).toLocaleString()}</b>.` : "");
    }
    el.summary.innerHTML = lead +
      stat("", "Predicted calls", Math.round(s.calls).toLocaleString(), `${s.n.toLocaleString()} hours`) +
      stat("", "Expected talk time", formatDuration(s.talkSec), `Average call ${s.meanAht === null ? "?" : (s.meanAht / SECONDS_PER_MINUTE).toFixed(1)} min`) +
      stat("", "Person-hours to schedule", s.personHours === null ? UNDEF : s.personHours.toLocaleString(), "Every hour, added up") +
      `<p class="story"><span>${story}</span></p>`;
    el.caveat.textContent = `${cache.window.caveat} Callers are assumed to give up after ${Math.round(c.patienceSec || 0)} s on average, measured from ` +
      `${cache.params.patience_source ? cache.params.patience_source.n_abandoned.toLocaleString() : "the"} past hang-ups.`;
  }

  // ---- detail sheet ----
  function inSelection(h) { return !!selection && selection.dates.includes(h.date) && h.hour >= selection.hours[0] && h.hour <= selection.hours[1]; }
  function openSheet(next) {
    view = next;
    document.body.classList.add("sheet-open");
    el.sheet.setAttribute("aria-hidden", "false");
    markActive();
    renderSheet();
  }
  function closeSheet() {
    view = null;
    document.body.classList.remove("sheet-open");
    el.sheet.setAttribute("aria-hidden", "true");
    if (selection) applySelection(null);
    markActive();
  }
  function markActive() {
    const key = view && view.type === "hour" ? view.key : null;
    cellIndex.forEach((td, k) => td.classList.toggle("active", k === key));
    const date = view && view.type === "day" ? view.date : null;
    el.rows.querySelectorAll("tr[data-d]").forEach((tr) => tr.classList.toggle("picked", tr.dataset.d === date));
  }
  function renderSheet() {
    if (!view || !cache) return;
    if (view.type === "hour" && hourIndex.has(view.key)) { const h = hourIndex.get(view.key); el.sheetTitle.textContent = `${dayLabel(h.date)}, ${pad2(h.hour)}:00`; el.sheetBody.innerHTML = hourView(h); return; }
    if (view.type === "selection" && selection) { el.sheetTitle.textContent = "Selection"; el.sheetBody.innerHTML = selectionView(); return; }
    if (view.type === "day") { el.sheetTitle.textContent = longDate(view.date); el.sheetBody.innerHTML = dayView(view.date); return; }
    closeSheet();
  }
  const line = (k, v, f, cls = "") => `<li class="${cls}"><div class="line"><span class="k">${k}</span><span class="v">${v}</span></div>${f ? `<div class="f">${f}</div>` : ""}</li>`;
  const tiles = (pairs) => `<div class="tiles">${pairs.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>`;
  function hourView(h) {
    const c = controls();
    const day = cache.days.find((d) => d.date === h.date);
    const chips = [h.cap_state === "over" ? `<span class="chip over">Over the cap</span>` : "", h.cap_state === "at" ? `<span class="chip at">At the cap</span>` : "",
      day && day.holiday ? `<span class="chip hol">${esc(day.holiday)}</span>` : ""].join("");
    let body = (chips ? `<div class="chips">${chips}</div>` : "") +
      `<div class="hero-n cap-${h.cap_state}"><span class="n">${h.staff_to_schedule === null ? UNDEF : h.staff_to_schedule}</span><span class="u">people to schedule</span></div><ul class="rows">` +
      line("Predicted calls", h.predicted_calls.toFixed(1), "Forecast for this hour") +
      line("Handle time", formatDuration(h.aht_sec), "Average for this weekday and hour, recent calls weighted more") +
      line("Expected talk time", formatDuration(h.load_erlangs * SPH), `${h.predicted_calls.toFixed(1)} calls × ${formatDuration(h.aht_sec)}`);
    if (h.staff_to_schedule === null) return body + `</ul><p class="reason">${esc(h.reason)}</p>`;
    body += line("Answered in time", pct(h.service_level_delivered, 1), `Target ${el.slNum.value}% within ${c.targetSec} s`) +
      line("Hang-ups", pct(h.abandon_share, 1), "Callers who give up before a peer answers");
    if (h.cap_state === "over") body += line(`With only ${MAX} people`, pct(h.service_level_if_capped, 1), "Answered in time if you can't staff above the cap", "out");
    return body + `</ul>` + (h.reason ? `<p class="reason">${esc(h.reason)}</p>` : "") +
      `<div class="sheet-foot"><button type="button" class="pill" data-open-day="${h.date}">See the whole day</button></div>`;
  }
  function selectionView() {
    const rows = computed.filter(inSelection);
    const s = L.summarize(rows);
    return `<p class="hint">${selection.dates.length} day${selection.dates.length === 1 ? "" : "s"}, ${pad2(selection.hours[0])}:00 to ${pad2(selection.hours[1])}:59, ${rows.length} hours</p>` +
      tiles([["Person-hours", s.personHours === null ? UNDEF : s.personHours.toLocaleString()], ["Peak staff", s.peakStaff === null ? UNDEF : s.peakStaff],
        ["Predicted calls", Math.round(s.calls).toLocaleString()], ["Expected hang-ups", s.abandoned === null ? UNDEF : Math.round(s.abandoned).toLocaleString()]]) +
      `<div class="sheet-foot"><button type="button" class="pill" data-clear-selection>Clear selection</button></div>`;
  }
  function dayView(date) {
    const day = judged.find((d) => d.date === date);
    if (!day) return `<p class="hint">${esc(date)} is outside the dates loaded. Widen the dates to see it.</p>`;
    const st = L.dayStats(day, computed.filter((h) => h.date === date));
    const tours = SHIFTS.map((spec) => {
      const s = day.shifts[spec.name], p = day.planned[spec.name];
      return `<tr><td>${spec.name}</td><td>${s.staff_needed === null ? UNDEF : s.staff_needed}</td><td>${p.planned === null ? UNDEF : p.planned}${p.is_own ? "" : "<small>following</small>"}</td>` +
        `<td class="${verdictClass(p.verdict)}">${p.verdict ? verdictShort(p.verdict) : UNDEF}${p.service_level === null ? "" : `<small>${pct(p.service_level)} in time</small>`}</td></tr>`;
    }).join("");
    const hoursList = (hs) => (hs.length ? hs.map((h) => `${pad2(h)}:00`).join(", ") : "None");
    return (day.holiday ? `<div class="chips"><span class="chip hol">${esc(day.holiday)}</span></div>` : "") +
      tiles([["Predicted calls", Math.round(st.calls).toLocaleString()], ["Busiest hour", st.peakHour === null ? UNDEF : `${pad2(st.peakHour)}:00`],
        ["Peak staff", st.peakStaff === null ? UNDEF : st.peakStaff], ["Expected hang-ups", st.abandoned === null ? UNDEF : Math.round(st.abandoned).toLocaleString()]]) +
      `<table class="tours"><tr><th>Tour</th><th>Need</th><th>Planned</th><th>Verdict</th></tr>${tours}</table>` +
      `<ul class="rows">${line("At the cap", hoursList(st.atCap))}${line("Over the cap", hoursList(st.overCap), "", st.overCap.length ? "out" : "")}</ul>`;
  }

  // ---- grid interaction ----
  function cellOf(e) { return e.target.closest && e.target.closest("td.h[data-k]"); }
  let drag = null;
  function rectFrom(a, b) {
    const dates = cache.days.map((d) => d.date);
    const [i0, i1] = [dates.indexOf(a.dataset.d), dates.indexOf(b.dataset.d)].sort((x, y) => x - y);
    const [h0, h1] = [Number(a.dataset.h), Number(b.dataset.h)].sort((x, y) => x - y);
    return { dates: dates.slice(i0, i1 + 1), hours: [h0, h1] };
  }
  function applySelection(sel) {
    selection = sel;
    cellIndex.forEach((td) => td.classList.toggle("sel", !!sel && sel.dates.includes(td.dataset.d) && Number(td.dataset.h) >= sel.hours[0] && Number(td.dataset.h) <= sel.hours[1]));
  }
  el.rows.addEventListener("pointerdown", (e) => { const c = cellOf(e); if (c && e.button === 0) drag = { anchor: c, moved: false }; });
  el.rows.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const node = document.elementFromPoint(e.clientX, e.clientY);
    const c = node && node.closest && node.closest("td.h[data-k]");
    if (!c || (c === drag.anchor && !drag.moved)) return;
    drag.moved = true;
    applySelection(rectFrom(drag.anchor, c));
    openSheet({ type: "selection" });
  });
  const endDrag = () => { setTimeout(() => { drag = null; }, 0); };
  el.rows.addEventListener("pointerup", endDrag);
  el.rows.addEventListener("pointercancel", endDrag);
  el.rows.addEventListener("click", (e) => {
    const dayBtn = e.target.closest && e.target.closest("[data-day]");
    if (dayBtn) { applySelection(null); openSheet({ type: "day", date: dayBtn.dataset.day }); return; }
    const c = cellOf(e);
    if (!c || (drag && drag.moved)) return;
    applySelection(null);
    if (view && view.type === "hour" && view.key === c.dataset.k) closeSheet(); else openSheet({ type: "hour", key: c.dataset.k });
  });
  el.rows.addEventListener("keydown", (e) => {
    const c = cellOf(e);
    if (c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); applySelection(null); openSheet({ type: "hour", key: c.dataset.k }); }
  });
  el.rows.addEventListener("input", (e) => {
    const input = e.target.closest && e.target.closest("td.roster input");
    if (!input) return;
    const v = input.value.trim();
    store.set(input.dataset.d, input.dataset.s, v === "" ? null : clampInt(v, 0, 99, null));
    judged = L.judgeRoster(L.rollupShifts(cache.days, computed), store, controls());
    patchShifts(judged);
    if (view && view.type === "day" && view.date === input.dataset.d) renderSheet();
  });
  el.sheetBody.addEventListener("click", (e) => {
    const day = e.target.closest("[data-open-day]");
    if (day) openSheet({ type: "day", date: day.dataset.openDay });
    if (e.target.closest("[data-clear-selection]")) closeSheet();
  });
  el.sheetClose.addEventListener("click", closeSheet);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && view) closeSheet(); });

  // ---- exports ----
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function exportCsv() {
    if (!cache) return;
    const csv = L.toCsv(L.csvRows(computed, judged));
    download(`v4w-staffing-${cache.window.start}-to-${cache.window.end}.csv`, new Blob([csv], { type: "text/csv" }));
  }
  // PNG: the grid is redrawn on a canvas from `computed`, not screenshotted,
  // so the export never depends on scroll position, viewport or theme. It
  // shows the hours currently shown.
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(",")})`; }
  function exportPng() {
    if (!cache) return;
    const P = PNG, font = "system-ui, -apple-system, Inter, sans-serif";
    const cols = [];
    visibleTours().forEach((t) => { t.hours.forEach((h) => cols.push({ h })); cols.push({ tour: t.spec }); });
    let x = P.pad + P.date;
    cols.forEach((col) => { col.x = x; col.w = col.tour ? P.roster : P.cell; x += col.w + 2; });
    const W = x + P.pad, H = P.pad * 2 + P.head + judged.length * (P.row + 2) + 24;
    const cv = document.createElement("canvas"); cv.width = W * 2; cv.height = H * 2;
    const g = cv.getContext("2d"); g.scale(2, 2);
    g.fillStyle = P.bg; g.fillRect(0, 0, W, H);
    g.textAlign = "left"; g.font = `600 14px ${font}`; g.fillStyle = P.ink;
    g.fillText(`Vets4Warriors: people to schedule per hour, ${cache.window.start} to ${cache.window.end}`, P.pad, P.pad + 12);
    g.font = `11px ${font}`; g.fillStyle = P.mute;
    g.fillText(`Efficiency ${el.effNum.value}% · ${el.slNum.value}% answered within ${targetSec()} s · ${cache.source ? cache.source.label : ""}`, P.pad, P.pad + 28);
    const y0 = P.pad + P.head;
    g.textAlign = "center";
    cols.forEach((col) => {
      g.font = `${col.tour ? 600 : 400} 10px ${font}`;
      g.fillStyle = col.tour || MAJOR_HOURS.has(col.h) ? P.ink : P.mute;
      g.fillText(col.tour ? `${col.tour.short} roster` : pad2(col.h), col.x + col.w / 2, y0 - 6);
    });
    judged.forEach((day, r) => {
      const y = y0 + r * (P.row + 2);
      g.textAlign = "left"; g.font = `12px ${font}`; g.fillStyle = P.ink;
      g.fillText(`${dayLabel(day.date)}${day.holiday ? " •" : ""}`, P.pad, y + 19);
      g.textAlign = "center"; g.font = `600 12px ${font}`;
      cols.forEach((col) => {
        if (col.tour) {
          const p = day.planned[col.tour.name];
          g.fillStyle = P.rosterBg; g.fillRect(col.x, y, col.w, P.row);
          g.fillStyle = p.verdict === null ? P.mute : !p.is_own ? P.ink : p.verdict === "on target" ? P.green : p.verdict === "overstaffed" ? P.amber : P.red;
          g.fillText(p.planned === null ? UNDEF : `${p.planned}${p.is_own ? "*" : ""}`, col.x + col.w / 2, y + 19);
          return;
        }
        const hr = hourIndex.get(L.key(day.date, col.h)); if (!hr) return;
        const st = hr.cap_state, lvl = st === "under" ? scale.levelOf(hr.staff_to_schedule) : 0;
        g.fillStyle = st === "over" ? P.red : st === "at" ? P.amberBg : mix(P.lo, P.hi, lvl * P.maxMix);
        g.fillRect(col.x, y, col.w, P.row);
        if (st === "at") { g.strokeStyle = P.amber; g.lineWidth = 2; g.strokeRect(col.x + 1, y + 1, col.w - 2, P.row - 2); }
        g.fillStyle = st === "over" || lvl > DEEP_LEVEL ? "#fff" : st === "at" ? P.amber : P.ink;
        g.fillText(hr.staff_to_schedule === null ? UNDEF : hr.staff_to_schedule, col.x + col.w / 2, y + 19);
      });
    });
    g.textAlign = "left"; g.font = `10px ${font}`; g.fillStyle = P.mute;
    g.fillText(`Red: over the cap of ${MAX}, never clamped. Amber: at the cap. Blue: under, one shade per person. * = your planned number. Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")}.`, P.pad, H - P.pad + 6);
    cv.toBlob((blob) => download(`v4w-staffing-grid-${cache.window.start}-to-${cache.window.end}.png`, blob), "image/png");
  }
  el.exportCsv.addEventListener("click", exportCsv);
  el.exportPng.addEventListener("click", exportPng);

  // ---- wiring ----
  let timer = null;
  function debounced(fn) { clearTimeout(timer); timer = setTimeout(fn, DEBOUNCE_MS); }
  const onLocal = () => { renderControlFeedback(); debounced(recompute); };
  el.eff.addEventListener("input", () => { el.effNum.value = el.eff.value; onLocal(); });
  el.effNum.addEventListener("input", () => { el.eff.value = clampInt(el.effNum.value, 0, 100, 65); onLocal(); });
  el.effNum.addEventListener("change", () => { el.effNum.value = el.eff.value; onLocal(); });
  el.sl.addEventListener("input", () => { el.slNum.value = el.sl.value; onLocal(); });
  el.slNum.addEventListener("input", () => { el.sl.value = clampInt(el.slNum.value, SL_MIN, SL_MAX, SL_MIN); onLocal(); });
  el.slNum.addEventListener("change", () => { el.slNum.value = el.sl.value; onLocal(); });
  el.tsec.addEventListener("input", onLocal);
  const onHours = () => {
    renderHours();
    if (!cache) return;
    buildGrid(cache.days);
    repaint();
    markActive();
    applySelection(selection);
  };
  el.hFrom.addEventListener("input", () => { if (Number(el.hFrom.value) > Number(el.hTo.value)) el.hFrom.value = el.hTo.value; onHours(); });
  el.hTo.addEventListener("input", () => { if (Number(el.hTo.value) < Number(el.hFrom.value)) el.hTo.value = el.hFrom.value; onHours(); });
  el.holidays.addEventListener("change", () => debounced(refresh));
  el.start.addEventListener("change", () => debounced(refresh));
  el.end.addEventListener("change", () => debounced(refresh));

  function init() {
    const today = new Date(), end = new Date(today); end.setDate(end.getDate() + DEFAULT_HORIZON_DAYS - 1);
    el.start.value = isoDate(today); el.end.value = isoDate(end);
    el.eff.value = "65"; el.effNum.value = "65"; el.sl.value = "80"; el.slNum.value = "80"; el.tsec.value = "30";
    el.hFrom.value = "0"; el.hTo.value = "23"; el.holidays.checked = true;
    const at = (v) => (v - SL_MIN) / (SL_MAX - SL_MIN);
    el.slTrack.querySelectorAll(".band, .tick").forEach((n) => n.remove());
    el.slTrack.insertAdjacentHTML("afterbegin",
      `<span class="band" style="left:${along(at(SL_CURRENT[0]))};width:calc((100% - ${THUMB_PX}px) * ${(at(SL_CURRENT[1]) - at(SL_CURRENT[0])).toFixed(4)})"></span>` +
      `<span class="tick" style="left:${along(at(SL_STANDARD))}"></span>`);
    renderControlFeedback();
    refresh();
  }
  init();
  // Browsers may restore form state after scripts ran (reload, back/forward).
  // pageshow fires after that restore, so defaults are reasserted.
  window.addEventListener("pageshow", (e) => { if (e.persisted) init(); });
})();
