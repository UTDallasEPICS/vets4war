/* DOM layer of the staffing console. All numbers come from web/logic.js
 * (and web/erlang.js underneath); this file only reads controls, renders,
 * and talks to the API. Read logic.js first if you want to know where a
 * number comes from.
 *
 * Data flow:
 *   date range / recency / holidays change  -> fetch /api/forecast (network)
 *   any other control                        -> recompute() in the browser (no network)
 *   planned value edited                     -> store + re-judge that shift (no network)
 */
(function () {
  "use strict";
  const L = V4WUI;
  const E = V4W;
  const HOURS = L.HOURS, SHIFTS = L.SHIFTS, MAX = L.MAX_STAFF_PER_SHIFT, SPH = L.SECONDS_PER_HOUR;
  const DEBOUNCE_MS = 60;
  const DEFAULT_HORIZON_DAYS = 30;
  const SECONDS_PER_MINUTE = 60;
  const MAJOR_HOURS = new Set([0, 6, 12, 18]);
  // How each handle-time weighting reads in the trace (db/aht.py presets).
  const RECENCY_LABEL = { equal: "unweighted", weighted: "recency-weighted (1-year halflife)", recent: "recent-weighted (90-day halflife)" };
  const SL_MIN = 80, SL_MAX = 95, SL_STANDARD = 90, SL_CURRENT = [80, 85];
  const UNDEF = "-";
  const PNG_CELL = 34, PNG_ROW = 30, PNG_DATE_W = 150, PNG_SUB_W = 46, PNG_PAD = 16, PNG_HEAD = 54;

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("start"), end: $("end"), eff: $("eff"), effNum: $("effNum"), sl: $("sl"), slNum: $("slNum"), tsec: $("tsec"),
    patience: $("patience"), patienceReset: $("patienceReset"), patienceFb: $("patienceFb"), recencyFb: $("recencyFb"),
    holidays: $("holidays"), changed: $("changed"), status: $("status"), bar: $("bar"), barToggle: $("barToggle"), barSummary: $("barSummary"),
    head: $("gridHead"), rows: $("rows"), scroll: $("gridScroll"), legend: $("legend"), gridNote: $("gridNote"),
    panelBody: $("panelBody"), pinBtn: $("pinBtn"), pickDate: $("pickDate"), pickClear: $("pickClear"),
    summary: $("summary"), footer: $("footer"), sourceBadge: $("sourceBadge"), exportPng: $("exportPng"), exportCsv: $("exportCsv"),
    error: $("error"), holidayNote: $("holidayNote"),
  };
  const modelEls = [...document.querySelectorAll('input[name="model"]')];
  const recencyEls = [...document.querySelectorAll('input[name="recency"]')];

  // ---- state ----
  let cache = null;          // { key, hours, days, window, params, source }
  let computed = [];         // hours with staffing for the current controls
  let judged = [];           // days with shift roll-up + planned verdicts
  let hourIndex = new Map(), cellIndex = new Map();
  let pinnedKey = null, hoverKey = null, selection = null, pickedDate = null;
  let patienceTouched = false;
  const store = L.createPlannedStore(safeStorage());

  function safeStorage() { try { return window.localStorage; } catch (_) { return null; } }

  // ---- helpers ----
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad2 = (n) => String(n).padStart(2, "0");
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function localDate(s) { return new Date(s + "T00:00:00"); }
  function shortDate(s) { return localDate(s).toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
  function longDate(s) { return localDate(s).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" }); }
  function formatDuration(sec) {
    const minutes = Math.floor(sec / SECONDS_PER_MINUTE + 0.5);
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  function queueModel() { return (modelEls.find((e) => e.checked) || modelEls[0]).value; }
  function recency() { return (recencyEls.find((e) => e.checked) || recencyEls[1]).value; }
  function estimatedPatience() { return cache && cache.params.patience_source && cache.params.patience_source.kind === "estimated" ? cache.params.patience_sec : null; }
  function patienceSec() {
    if (queueModel() === "erlang_c") return null;
    const v = Number(el.patience.value);
    if (Number.isFinite(v) && v > 0) return Math.min(v, Number(el.patience.max));
    return cache ? cache.params.patience_sec : null;
  }
  function targetSec() { const v = Number(el.tsec.value); return Number.isFinite(v) && v >= 0 ? Math.min(v, Number(el.tsec.max)) : Number(el.tsec.defaultValue); }
  function controls() {
    return { efficiency: Number(el.effNum.value) / 100, targetPct: Number(el.slNum.value) / 100, targetSec: targetSec(), patienceSec: patienceSec() };
  }
  function rangeKey() { return `${el.start.value}|${el.end.value}|${recency()}|${el.holidays.checked}`; }

  // ---- controls: sync + feedback ----
  function clampInt(v, lo, hi, fallback) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; }
  function syncPair(range, number) { number.value = range.value; }
  function setFill(range) {
    const p = ((range.value - range.min) / (range.max - range.min)) * 100;
    range.style.setProperty("--fill", p.toFixed(1) + "%");
  }
  function renderControlFeedback() {
    setFill(el.eff); setFill(el.sl);
    const estimate = estimatedPatience();
    const c = controls();
    el.patience.disabled = queueModel() === "erlang_c";
    if (queueModel() === "erlang_c") {
      el.patienceFb.textContent = "Erlang C: nobody hangs up";
      el.patienceReset.hidden = true;
    } else if (!patienceTouched || (estimate !== null && Math.round(c.patienceSec) === Math.round(estimate))) {
      el.patienceFb.textContent = estimate !== null ? `measured, ${cache.params.patience_source.n_abandoned.toLocaleString()} abandons` : "";
      el.patienceReset.hidden = true;
    } else {
      el.patienceFb.textContent = `your override; data says ${estimate === null ? "?" : Math.round(estimate)} s`;
      el.patienceReset.hidden = false;
    }
    if (cache) {
      const eff = cache.window.recency_effect_pct;
      el.recencyFb.textContent = recency() === "equal" ? "every call weighs the same" :
        `${eff >= 0 ? "raises" : "lowers"} expected talk time ${Math.abs(eff).toFixed(1)}% vs equal weighting`;
    }
    el.barSummary.textContent = `${shortDate(el.start.value)} to ${shortDate(el.end.value)} · efficiency ${el.effNum.value}% · ` +
      `${el.slNum.value}% in ${targetSec()} s · ${queueModel() === "erlang_a" ? `Erlang A, patience ${Math.round(c.patienceSec || 0)} s` : "Erlang C"} · ` +
      `${recency()} weighting · holidays ${el.holidays.checked ? "on" : "off"}`;
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
    const p = new URLSearchParams({ start: el.start.value, end: el.end.value, queue_model: queueModel(), recency: recency(),
      include_holidays: String(el.holidays.checked), efficiency: c.efficiency.toFixed(2), target_pct: c.targetPct.toFixed(2), target_sec: String(c.targetSec) });
    if (patienceTouched && c.patienceSec !== null) p.set("patience_sec", String(c.patienceSec));
    return p;
  }
  let inflight = 0;
  async function refresh() {
    const k = rangeKey();
    if (cache && cache.key === k) { recompute(); return; }
    const id = ++inflight;
    el.status.textContent = "Loading forecast…";
    document.body.classList.add("is-loading");
    try {
      const data = await fetchJson("/api/forecast?" + serverParams());
      if (id !== inflight) return;
      cache = { key: k, hours: data.hours.map((h) => ({ date: h.date, hour: h.hour, predicted_calls: h.predicted_calls, aht_sec: h.aht_sec })),
        days: data.days, window: data.window, params: data.params, source: data.data_source, coverage: data.holiday_coverage };
      if (!patienceTouched && data.params.patience_sec) el.patience.value = String(Math.round(data.params.patience_sec));
      el.error.hidden = true;
      renderSourceBadge(cache.source);
      el.holidayNote.hidden = !cache.coverage.message;
      el.holidayNote.textContent = cache.coverage.message || "";
      selection = null; pinnedKey = null; hoverKey = null;
      if (pickedDate && !cache.days.some((d) => d.date === pickedDate)) pickedDate = null;
      buildGrid(cache.days);
      computed = [];
      recompute();
    } catch (err) {
      if (id !== inflight) return;
      cache = null;
      el.error.hidden = false; el.error.textContent = err.message;
      el.rows.innerHTML = ""; el.status.textContent = "";
    } finally {
      if (id === inflight) document.body.classList.remove("is-loading");
    }
  }
  function renderSourceBadge(src) {
    if (!src) return;
    el.sourceBadge.className = `badge src-${src.kind}`;
    el.sourceBadge.textContent = src.kind === "unlabeled" ? src.label : `${src.label} · ${src.start} to ${src.end}`;
  }

  // ---- grid skeleton (once per range) ----
  function buildGrid(days) {
    const groups = SHIFTS.map((s) =>
      `<th class="group" colspan="${s.core.length + 2}"><span>${s.name}</span><small>${s.span}</small></th>`).join("");
    const hourHeads = (spec) => spec.core.map((h) => `<th class="hh${MAJOR_HOURS.has(h) ? " major" : ""}" data-h="${h}">${pad2(h)}</th>`).join("") +
      `<th class="sub"><span>peak</span><small>p-h</small></th><th class="plan">planned</th>`;
    el.head.innerHTML = `<tr><th class="date" rowspan="2">Date</th>${groups}<th class="total" rowspan="2"><span>total</span><small>p-h</small></th></tr>` +
      `<tr>${SHIFTS.map(hourHeads).join("")}</tr>`;
    const today = isoDate(new Date());
    el.rows.innerHTML = days.map((day) => {
      const dt = localDate(day.date);
      const cls = [day.is_weekend ? "weekend" : "", day.date === today ? "today" : "", day.holiday ? "holiday" : ""].join(" ").trim();
      const cells = SHIFTS.map((spec) =>
        spec.core.map((h) => `<td class="h${MAJOR_HOURS.has(h) ? " major" : ""}" data-k="${L.key(day.date, h)}" data-d="${day.date}" data-h="${h}" tabindex="0"></td>`).join("") +
        `<td class="sub" data-sub="${L.shiftKey(day.date, spec.name)}"></td>` +
        `<td class="plan" data-plan="${L.shiftKey(day.date, spec.name)}"><input type="number" name="planned" min="0" max="99" step="1" inputmode="numeric" aria-label="Planned staff, ${spec.name} ${day.date}" data-d="${day.date}" data-s="${spec.name}"><span class="badge-v"></span></td>`
      ).join("");
      const meta = day.holiday ? `<span class="hol" title="${esc(day.holiday)}">${esc(day.holiday)}</span>` : (day.date === today ? "Today" : "");
      return `<tr class="${cls}" data-d="${day.date}"><td class="date"><div class="d">${dt.toLocaleDateString(undefined, { weekday: "short" })}<span class="dm">${dt.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span></div><div class="meta">${meta}</div></td>${cells}<td class="total" data-total="${day.date}"></td></tr>`;
    }).join("");
    cellIndex = new Map([...el.rows.querySelectorAll("td.h[data-k]")].map((td) => [td.dataset.k, td]));
    el.gridNote.textContent = "Tours overlap by 30 minutes (Day 08:00 to 16:30, Evening 16:00 to 00:30, Overnight 00:00 to 08:30). " +
      "The overlap hour counts toward the peak of both adjacent tours and toward the calls and person-hours of the tour that starts it. " +
      "peak = the busiest hour's people to schedule, the number to roster against; p-h = person-hours, the sum over the tour's hours. " +
      "Planned: type your roster per tour; empty follows the recommendation.";
  }

  // ---- recompute (no network) ----
  function recompute() {
    if (!cache) return;
    const t0 = performance.now();
    const c = controls();
    const next = L.computeHours(cache.hours, c);
    const changed = L.diffCells(computed, next);
    computed = next;
    hourIndex = new Map(computed.map((h) => [L.key(h.date, h.hour), h]));
    judged = L.judgeRoster(L.rollupShifts(cache.days, computed), store, c);
    patchCells(computed);
    patchShifts(judged);
    renderLegend();
    renderSummary(c);
    renderPanel();
    renderControlFeedback();
    const ms = performance.now() - t0;
    // Shown after every recompute that moved anything, including the first
    // load, so a slider's effect is visible without hunting for it.
    el.changed.textContent = changed > 0 ? `${changed} cell${changed === 1 ? "" : "s"} changed` : "no cells changed";
    el.status.textContent = `${cache.days.length} days · ${computed.length} hours · ${ms.toFixed(0)} ms`;
  }

  function patchCells(hours) {
    const scale = L.discreteScale(hours.map((h) => h.staff_to_schedule));
    const peaks = new Set(L.peakHours(hours));
    el.head.querySelectorAll("th.hh").forEach((th) => th.classList.toggle("peak", peaks.has(Number(th.dataset.h))));
    hours.forEach((h) => {
      const td = cellIndex.get(L.key(h.date, h.hour));
      if (!td) return;
      const staff = h.staff_to_schedule;
      td.style.setProperty("--lvl", h.cap_state === "under" ? scale.levelOf(staff).toFixed(3) : "0");
      td.className = `h cap-${h.cap_state}${MAJOR_HOURS.has(h.hour) ? " major" : ""}${h.implausible ? " implausible" : ""}` +
        `${inSelection(h) ? " sel" : ""}${pinnedKey === L.key(h.date, h.hour) ? " active" : ""}`;
      td.innerHTML = h.cap_state === "over"
        ? `<span class="n">${staff}</span><span class="cl">${pct(h.service_level_if_capped)} at ${MAX}</span>`
        : `<span class="n">${staff === null ? UNDEF : staff}</span>`;
    });
    el.scale = scale;
  }

  function patchShifts(days) {
    days.forEach((day) => {
      SHIFTS.forEach((spec) => {
        const s = day.shifts[spec.name], p = day.planned[spec.name];
        const k = L.shiftKey(day.date, spec.name);
        const sub = el.rows.querySelector(`td.sub[data-sub="${k}"]`);
        if (sub) {
          sub.className = `sub cap-${L.capState(s.staff_needed)}`;
          sub.innerHTML = `<span class="n">${s.staff_needed === null ? UNDEF : s.staff_needed}</span><small>${s.person_hours === null ? UNDEF : s.person_hours}</small>`;
        }
        const plan = el.rows.querySelector(`td.plan[data-plan="${k}"]`);
        if (plan) {
          const input = plan.querySelector("input"), badge = plan.querySelector(".badge-v");
          if (document.activeElement !== input) input.value = p.planned === null ? "" : p.planned;
          input.placeholder = s.staff_needed === null ? UNDEF : s.staff_needed;
          plan.classList.toggle("own", p.is_own);
          if (p.verdict === null) { badge.className = "badge-v"; badge.textContent = UNDEF; }
          else {
            badge.className = `badge-v v-${p.verdict.replace(/ /g, "-")}`;
            badge.innerHTML = `${verdictShort(p.verdict)}<small>${p.delta > 0 ? "+" : ""}${p.delta} · SL ${pct(p.service_level)}</small>`;
            badge.title = `${p.verdict}: ${p.planned} planned vs ${p.recommended} recommended. ${p.effective_agents} on inbound after efficiency; ` +
              `lowest hour delivers ${pct(p.service_level, 1)}${p.abandon_share === null ? "" : `, worst hour loses ${pct(p.abandon_share, 1)} of callers`}.`;
          }
        }
      });
      const total = el.rows.querySelector(`td.total[data-total="${day.date}"]`);
      if (total) total.textContent = day.person_hours === null ? UNDEF : day.person_hours;
    });
  }
  function verdictShort(v) { return { "understaffed": "under", "on target": "on target", "overstaffed": "over", "exceeds capacity": "exceeds cap" }[v] || v; }

  function renderLegend() {
    const s = el.scale || { lo: 0, hi: 0 };
    $("legendRange").textContent = s.lo === s.hi ? `${s.lo}` : `${s.lo} to ${s.hi}`;
  }

  // ---- summary strip ----
  function renderSummary(c) {
    const s = L.summarize(computed);
    const fewer = L.abandonedOneFewer(computed, c);
    const tile = (cls, lbl, val, sub) => `<div class="tile ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
    const talkHours = s.talkSec / SPH;
    let abandonTile;
    if (queueModel() === "erlang_c") abandonTile = tile("big", "Expected hang-ups", "n/a", "Erlang C assumes nobody hangs up");
    else if (s.abandoned === null) abandonTile = tile("big", "Expected hang-ups", UNDEF, "undefined at 0% efficiency");
    else abandonTile = tile("big", "Expected hang-ups", `${s.abandoned.toFixed(0)}<small>${s.calls > 0 ? pct(s.abandoned / s.calls, 1) : ""}</small>`,
      `<b>${s.abandoned.toFixed(0)} callers expected to hang up before a peer answers</b>, at the recommended staffing, ${shortDate(cache.window.start)} to ${shortDate(cache.window.end)}`);
    let slack;
    if (s.personHours === null) slack = `Scheduled person-hours are undefined at 0% efficiency.`;
    else {
      const gap = s.personHours - talkHours, ratio = talkHours > 0 ? s.personHours / talkHours : null;
      slack = `Scheduled person-hours exceed expected talk time by <b>${formatDuration(Math.max(0, gap) * SPH)}</b>${ratio ? ` (${ratio.toFixed(1)}× the talk time)` : ""}. ` +
        `That gap is the efficiency assumption (${el.effNum.value}% of a shift on inbound) plus the queue slack ${queueModel() === "erlang_a" ? "Erlang A" : "Erlang C"} adds to answer ${el.slNum.value}% within ${c.targetSec} s.` +
        (fewer !== null && s.abandoned !== null ? ` <b>What the slack buys:</b> at one fewer person per hour, expected hang-ups rise from <b>${s.abandoned.toFixed(0)}</b> to <b>${fewer.toFixed(0)}</b>.` : "");
    }
    el.summary.innerHTML = `<div class="tiles">${abandonTile}` +
      tile("", "Predicted calls", s.calls.toFixed(0), `${s.n} hours`) +
      tile("", "Expected talk time", formatDuration(s.talkSec), `${s.calls.toFixed(0)} calls × ${s.meanAht === null ? "?" : (s.meanAht / SECONDS_PER_MINUTE).toFixed(1)} min`) +
      tile("", "Scheduled person-hours", s.personHours === null ? UNDEF : s.personHours.toLocaleString(), "sum of people to schedule, every hour") +
      `</div><p class="slack">${slack}</p><p class="caveat">${esc(cache.window.caveat)}</p>`;
  }

  // ---- docked panel ----
  function inSelection(h) { return !!selection && selection.dates.includes(h.date) && h.hour >= selection.hours[0] && h.hour <= selection.hours[1]; }
  function renderPanel() {
    const k = pinnedKey || hoverKey;
    el.pinBtn.hidden = !pinnedKey;
    if (k && hourIndex.has(k)) { el.panelBody.innerHTML = hourView(hourIndex.get(k), !!pinnedKey); return; }
    if (selection) { el.panelBody.innerHTML = selectionView(); return; }
    if (pickedDate) { el.panelBody.innerHTML = dayView(pickedDate); return; }
    el.panelBody.innerHTML = `<p class="hint">Hover a cell for its trace, click to pin it, drag across cells to total a selection, or pick a date above for a day summary.</p>`;
  }
  const row = (k, v, f, out) => `<tr class="${out ? "out" : ""}"><td class="k">${k}</td><td class="v">${v}</td></tr>` + (f ? `<tr><td class="f" colspan="2">${f}</td></tr>` : "");
  function hourView(h, pinned) {
    const c = controls();
    const fmt = (v, d) => Number(v).toFixed(d);
    const flag = h.cap_state === "over" ? `<span class="flag over">over cap</span>` : h.cap_state === "at" ? `<span class="flag at">at cap</span>` : "";
    let body = `<h3><span>${esc(h.date)} ${pad2(h.hour)}:00</span>${flag}${pinned ? `<span class="pinned">pinned</span>` : ""}</h3>` +
      `<div class="big-out cap-${h.cap_state}"><span class="n">${h.staff_to_schedule === null ? UNDEF : h.staff_to_schedule}</span><span class="u">people to schedule</span></div><table>` +
      row("predicted calls", fmt(h.predicted_calls, 2), "LightGBM Poisson, this hour") +
      row("handle time", `${fmt(h.aht_sec, 0)} s`, `${RECENCY_LABEL[recency()]} mean for this weekday and hour`) +
      row("expected talk time", formatDuration(h.load_erlangs * SPH), `${fmt(h.predicted_calls, 2)} × ${fmt(h.aht_sec, 0)} s`) +
      row("load", `${fmt(h.load_erlangs, 3)} erlangs`, `talk time ÷ ${SPH}`) +
      row("agents required", h.agents_required, h.queue_model === "erlang_a"
        ? `smallest N with Erlang A service level ≥ ${el.slNum.value}% in ${c.targetSec} s, callers giving up after ${Math.round(h.patience_sec)} s on average`
        : `smallest N with Erlang C service level ≥ ${el.slNum.value}% in ${c.targetSec} s`);
    if (h.staff_to_schedule === null) return body + row("÷ efficiency", `${h.agents_required} ÷ 0`, "undefined", true) + `</table><p class="reason">${esc(h.reason)}</p>`;
    body += row("÷ efficiency", `${h.agents_required} ÷ ${fmt(c.efficiency, 2)} = ${fmt(h.agents_required / c.efficiency, 2)}`, "share of a shift actually on inbound") +
      row("staff to schedule", h.staff_to_schedule, `ceil(${fmt(h.agents_required / c.efficiency, 2)})`, true) +
      row("effective agents", h.effective_agents, `floor(${h.staff_to_schedule} × ${fmt(c.efficiency, 2)})`) +
      row("service level delivered", pct(h.service_level_delivered, 1), `with ${h.effective_agents} on inbound; target ${el.slNum.value}% in ${c.targetSec} s`) +
      (h.queue_model === "erlang_a" ? row("hang-ups", pct(h.abandon_share, 1), `callers who give up before answer with ${h.effective_agents} on inbound`) : row("hang-ups", "n/a", "Erlang C assumes nobody hangs up"));
    if (h.cap_state === "over") body += row(`if capped at ${MAX}`, pct(h.service_level_if_capped, 1), `service level with floor(${MAX} × ${fmt(c.efficiency, 2)}) = ${Math.floor(MAX * c.efficiency)} on inbound`, true);
    return body + `</table>` + (h.reason ? `<p class="reason">${esc(h.reason)}</p>` : "");
  }
  function selectionView() {
    const rows = computed.filter(inSelection);
    const s = L.summarize(rows);
    return `<h3><span>Selection</span><button type="button" class="link" id="selClear">clear</button></h3>` +
      `<p class="scope">${selection.dates.length} date${selection.dates.length === 1 ? "" : "s"}, ${pad2(selection.hours[0])}:00 to ${pad2(selection.hours[1])}:59, ${rows.length} cells</p>` +
      outGrid([["person-hours", s.personHours === null ? UNDEF : s.personHours.toLocaleString()], ["peak staff", s.peakStaff === null ? UNDEF : s.peakStaff],
        ["predicted calls", s.calls.toFixed(0)], ["expected hang-ups", s.abandoned === null ? "n/a" : s.abandoned.toFixed(0)]]);
  }
  function outGrid(pairs) { return `<div class="outs">${pairs.map(([k, v]) => `<div class="out-tile"><div class="lbl">${k}</div><div class="val">${v}</div></div>`).join("")}</div>`; }
  function dayView(date) {
    const day = judged.find((d) => d.date === date);
    if (!day) return `<p class="hint">${esc(date)} is outside the loaded window. Extend the date range to inspect it.</p>`;
    const st = L.dayStats(day, computed.filter((h) => h.date === date));
    const shifts = SHIFTS.map((spec) => {
      const s = day.shifts[spec.name], p = day.planned[spec.name];
      return `<tr><td class="k">${spec.name}</td><td class="v">${s.staff_needed === null ? UNDEF : s.staff_needed}</td>` +
        `<td class="v">${p.planned === null ? UNDEF : p.planned}</td><td class="v ${p.verdict ? `v-${p.verdict.replace(/ /g, "-")}` : ""}">${p.verdict ? verdictShort(p.verdict) : UNDEF}${p.service_level === null ? "" : `<small> SL ${pct(p.service_level)}</small>`}</td></tr>`;
    }).join("");
    const hoursList = (hs) => hs.length ? hs.map((h) => `${pad2(h)}:00`).join(", ") : "none";
    return `<h3><span>${esc(longDate(date))}</span>${day.holiday ? `<span class="flag hol">${esc(day.holiday)}</span>` : ""}</h3>` +
      outGrid([["predicted calls", st.calls.toFixed(0)], ["peak hour", st.peakHour === null ? UNDEF : `${pad2(st.peakHour)}:00`],
        ["peak staff", st.peakStaff === null ? UNDEF : st.peakStaff], ["expected hang-ups", st.abandoned === null ? "n/a" : st.abandoned.toFixed(0)]]) +
      `<table class="shifts"><tr><th>tour</th><th>need</th><th>planned</th><th>verdict</th></tr>${shifts}</table>` +
      `<p class="scope">At cap: ${hoursList(st.atCap)}.<br>Over cap: ${hoursList(st.overCap)}.</p>`;
  }

  // ---- grid interaction ----
  function cellOf(e) { return e.target.closest && e.target.closest("td.h[data-k]"); }
  function setPinned(k) {
    if (pinnedKey && cellIndex.has(pinnedKey)) cellIndex.get(pinnedKey).classList.remove("active");
    pinnedKey = k;
    if (k && cellIndex.has(k)) cellIndex.get(k).classList.add("active");
    renderPanel();
  }
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
    renderPanel();
  }
  el.rows.addEventListener("pointerdown", (e) => { const c = cellOf(e); if (c && e.button === 0) { drag = { anchor: c, moved: false }; } });
  el.rows.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const node = document.elementFromPoint(e.clientX, e.clientY);
    const c = node && node.closest && node.closest("td.h[data-k]");
    if (!c || (c === drag.anchor && !drag.moved)) return;
    if (!drag.moved) { drag.moved = true; setPinned(null); }
    applySelection(rectFrom(drag.anchor, c));
  });
  const endDrag = () => { drag = null; };
  el.rows.addEventListener("pointerup", endDrag);
  el.rows.addEventListener("pointercancel", endDrag);
  el.rows.addEventListener("mouseover", (e) => { const c = cellOf(e); if (c && !drag) { hoverKey = c.dataset.k; if (!pinnedKey) renderPanel(); } });
  el.rows.addEventListener("mouseleave", () => { hoverKey = null; if (!pinnedKey) renderPanel(); });
  el.rows.addEventListener("focusin", (e) => { const c = cellOf(e); if (c) { hoverKey = c.dataset.k; if (!pinnedKey) renderPanel(); } });
  el.rows.addEventListener("click", (e) => {
    const c = cellOf(e);
    if (!c || (drag && drag.moved)) return;
    setPinned(pinnedKey === c.dataset.k ? null : c.dataset.k);
  });
  el.rows.addEventListener("input", (e) => {
    const input = e.target.closest && e.target.closest("td.plan input");
    if (!input) return;
    const v = input.value.trim();
    store.set(input.dataset.d, input.dataset.s, v === "" ? null : clampInt(v, 0, 99, null));
    const c = controls();
    judged = L.judgeRoster(L.rollupShifts(cache.days, computed), store, c);
    patchShifts(judged);
    if (pickedDate === input.dataset.d && !pinnedKey && !hoverKey && !selection) renderPanel();
  });
  el.panelBody.addEventListener("click", (e) => { if (e.target.id === "selClear") applySelection(null); });
  el.pinBtn.addEventListener("click", () => setPinned(null));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { setPinned(null); applySelection(null); } });
  el.scroll.addEventListener("scroll", () => {
    el.scroll.parentElement.classList.toggle("scrolled-x", el.scroll.scrollLeft > 0);
    el.scroll.parentElement.classList.toggle("scrolled-y", el.scroll.scrollTop > 0);
  }, { passive: true });

  // ---- day picker ----
  function setPicked(date) {
    pickedDate = date || null;
    el.rows.querySelectorAll("tr.picked").forEach((tr) => tr.classList.remove("picked"));
    if (pickedDate) { const tr = el.rows.querySelector(`tr[data-d="${pickedDate}"]`); if (tr) { tr.classList.add("picked"); tr.scrollIntoView({ block: "nearest" }); } }
    renderPanel();
  }
  el.pickDate.addEventListener("change", () => setPicked(el.pickDate.value));
  el.pickClear.addEventListener("click", () => { el.pickDate.value = ""; setPicked(null); });

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
  // so the export never depends on scroll position or viewport size.
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(",")})`; }
  function exportPng() {
    if (!cache) return;
    const lo = cssVar("--heat-lo"), hi = cssVar("--heat-hi"), bg = cssVar("--surface"), ink = cssVar("--text"), mute = cssVar("--text-3"),
      amber = cssVar("--amber"), red = cssVar("--red"), border = cssVar("--border"), maxMix = parseFloat(cssVar("--heat-max-mix")) / 100;
    const cols = 24 * PNG_CELL + 3 * PNG_SUB_W + PNG_SUB_W;
    const W = PNG_PAD * 2 + PNG_DATE_W + cols, H = PNG_PAD * 2 + PNG_HEAD + cache.days.length * PNG_ROW + 24;
    const cv = document.createElement("canvas"); cv.width = W * 2; cv.height = H * 2;
    const g = cv.getContext("2d"); g.scale(2, 2);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.font = "600 13px Inter, system-ui, sans-serif"; g.fillStyle = ink;
    g.fillText(`Vets4Warriors staffing forecast: people to schedule per hour, ${cache.window.start} to ${cache.window.end}`, PNG_PAD, PNG_PAD + 12);
    g.font = "11px Inter, system-ui, sans-serif"; g.fillStyle = mute;
    g.fillText(`efficiency ${el.effNum.value}% · ${el.slNum.value}% answered within ${targetSec()} s · ${queueModel() === "erlang_a" ? "Erlang A" : "Erlang C"} · ${recency()} weighting · ${cache.source ? cache.source.label : ""}`, PNG_PAD, PNG_PAD + 28);
    const x0 = PNG_PAD + PNG_DATE_W, y0 = PNG_PAD + PNG_HEAD;
    const colX = (h) => x0 + h * PNG_CELL + Math.floor(h / 8) * PNG_SUB_W;
    g.font = "10px ui-monospace, Menlo, monospace"; g.textAlign = "center";
    HOURS.forEach((h) => { g.fillStyle = MAJOR_HOURS.has(h) ? ink : mute; g.fillText(pad2(h), colX(h) + PNG_CELL / 2, y0 - 6); });
    SHIFTS.forEach((s, i) => { g.fillStyle = ink; g.fillText(`${s.short} peak`, colX(s.core[7]) + PNG_CELL + PNG_SUB_W / 2, y0 - 6); g.fillText(s.name, colX(s.core[0]) + 4 * PNG_CELL, y0 - 20); });
    g.fillText("total", colX(23) + PNG_CELL + PNG_SUB_W / 2, y0 - 6);
    judged.forEach((day, r) => {
      const y = y0 + r * PNG_ROW;
      g.textAlign = "left"; g.font = "12px Inter, system-ui, sans-serif"; g.fillStyle = ink;
      g.fillText(`${localDate(day.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}${day.holiday ? " ·" : ""}`, PNG_PAD, y + 19);
      HOURS.forEach((h) => {
        const row_ = hourIndex.get(L.key(day.date, h)); if (!row_) return;
        const x = colX(h), st = row_.cap_state;
        g.fillStyle = st === "over" ? red : st === "under" ? mix(lo, hi, el.scale.levelOf(row_.staff_to_schedule) * maxMix) : lo;
        g.fillRect(x, y, PNG_CELL - 1, PNG_ROW - 1);
        if (st === "at") { g.fillStyle = amber; g.fillRect(x, y, 3, PNG_ROW - 1); }
        g.fillStyle = st === "over" ? "#fff" : st === "at" ? amber : ink; g.textAlign = "center"; g.font = "600 12px ui-monospace, Menlo, monospace";
        g.fillText(row_.staff_to_schedule === null ? UNDEF : row_.staff_to_schedule, x + PNG_CELL / 2, y + 19);
      });
      SHIFTS.forEach((s) => {
        const sh = day.shifts[s.name], x = colX(s.core[7]) + PNG_CELL;
        g.fillStyle = border; g.fillRect(x, y, PNG_SUB_W - 1, PNG_ROW - 1);
        g.fillStyle = sh.capped ? red : ink; g.textAlign = "center"; g.font = "600 12px ui-monospace, Menlo, monospace";
        g.fillText(sh.staff_needed === null ? UNDEF : sh.staff_needed, x + PNG_SUB_W / 2, y + 19);
      });
      g.fillStyle = ink; g.fillText(day.person_hours === null ? UNDEF : day.person_hours, colX(23) + PNG_CELL + PNG_SUB_W / 2, y + 19);
    });
    g.textAlign = "left"; g.font = "10px Inter, system-ui, sans-serif"; g.fillStyle = mute;
    g.fillText(`Red = over the cap of ${MAX} (never clamped); amber edge = at the cap; blue shades = under, one per person. Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")}.`, PNG_PAD, H - PNG_PAD + 6);
    cv.toBlob((blob) => download(`v4w-staffing-grid-${cache.window.start}-to-${cache.window.end}.png`, blob), "image/png");
  }
  el.exportCsv.addEventListener("click", exportCsv);
  el.exportPng.addEventListener("click", exportPng);

  // ---- footer: model credibility ----
  async function loadFooter() {
    try {
      const m = await fetchJson("/api/model");
      const overall = (m.backtest && m.backtest.overall) || [];
      const by = Object.fromEntries(overall.map((r) => [r.model, r]));
      const lgbm = by.lgbm_poisson, naive = by.seasonal_naive, mean = by.overall_mean;
      if (!lgbm) throw new Error("metadata has no backtest.overall");
      const folds = m.backtest.holdout_months || new Set((m.backtest.per_fold || []).map((r) => r.fold)).size;
      renderSourceBadge(m.data_source);
      el.footer.innerHTML = `<h2>How much to trust these numbers</h2>` +
        `<div class="cred"><div class="tile"><div class="lbl">Daily-total error</div><div class="val">${lgbm.daily_mae.toFixed(1)}<small>calls/day</small></div><div class="sub">LightGBM Poisson${naive ? `; seasonal naive ${naive.daily_mae.toFixed(1)}` : ""}${mean ? `; flat mean ${mean.daily_mae.toFixed(1)}` : ""}</div></div>` +
        `<div class="tile"><div class="lbl">Hourly error</div><div class="val">${lgbm.mae.toFixed(2)}<small>calls/hour</small></div><div class="sub">MAPE ${lgbm.mape_pct.toFixed(0)}% on hours with calls${naive ? `; naive ${naive.mae.toFixed(2)}` : ""}</div></div>` +
        `<div class="tile"><div class="lbl">Backtest window</div><div class="val">${folds}<small>monthly folds</small></div><div class="sub">${m.backtest.first_test_month.slice(0, 7)} to ${m.backtest.last_test_month.slice(0, 7)}, each month predicted with no access to it</div></div>` +
        `<div class="tile"><div class="lbl">Training data</div><div class="val">${m.train_rows.toLocaleString()}<small>hours</small></div><div class="sub">${m.train_start.slice(0, 10)} to ${m.train_end.slice(0, 10)}, ${m.features.length} features</div></div></div>` +
        `<p class="sub">Model error, not magic: every cell carries about plus or minus one person. Rolling-origin backtest; the model only ever saw months before the one it predicted. Exact per-fold numbers are in models/metadata.json.</p>`;
    } catch (err) {
      el.footer.innerHTML = `<p class="err">Model metadata unavailable: ${esc(err.message)}</p>`;
    }
  }

  // ---- wiring ----
  let timer = null;
  function debounced(fn) { clearTimeout(timer); timer = setTimeout(fn, DEBOUNCE_MS); }
  const onLocal = () => { renderControlFeedback(); debounced(recompute); };
  el.eff.addEventListener("input", () => { syncPair(el.eff, el.effNum); onLocal(); });
  el.effNum.addEventListener("input", () => { el.eff.value = clampInt(el.effNum.value, 0, 100, 65); onLocal(); });
  el.effNum.addEventListener("change", () => { el.effNum.value = el.eff.value; onLocal(); });
  el.sl.addEventListener("input", () => { syncPair(el.sl, el.slNum); onLocal(); });
  el.slNum.addEventListener("input", () => { el.sl.value = clampInt(el.slNum.value, SL_MIN, SL_MAX, SL_MIN); onLocal(); });
  el.slNum.addEventListener("change", () => { el.slNum.value = el.sl.value; onLocal(); });
  el.tsec.addEventListener("input", onLocal);
  el.patience.addEventListener("input", () => { patienceTouched = true; onLocal(); });
  el.patienceReset.addEventListener("click", () => { patienceTouched = false; const est = estimatedPatience(); if (est !== null) el.patience.value = String(Math.round(est)); onLocal(); });
  modelEls.forEach((e) => e.addEventListener("change", onLocal));
  recencyEls.forEach((e) => e.addEventListener("change", () => debounced(refresh)));
  el.holidays.addEventListener("change", () => debounced(refresh));
  el.start.addEventListener("change", () => debounced(refresh));
  el.end.addEventListener("change", () => debounced(refresh));
  el.barToggle.addEventListener("click", () => {
    const collapsed = el.bar.classList.toggle("collapsed");
    el.barToggle.textContent = collapsed ? "Expand" : "Collapse";
    el.barSummary.hidden = !collapsed;
  });

  function init() {
    const today = new Date(), end = new Date(today); end.setDate(end.getDate() + DEFAULT_HORIZON_DAYS - 1);
    el.start.value = isoDate(today); el.end.value = isoDate(end);
    el.eff.value = "65"; el.effNum.value = "65"; el.sl.value = "80"; el.slNum.value = "80"; el.tsec.value = "30";
    el.patience.value = ""; el.holidays.checked = true;
    modelEls[0].checked = true; recencyEls[1].checked = true;
    const marks = $("slMarks");
    const at = (v) => `${((v - SL_MIN) / (SL_MAX - SL_MIN)) * 100}%`;
    marks.innerHTML = `<span class="bound lo">${SL_MIN}</span><span class="bound hi">${SL_MAX}</span>` +
      `<span class="band" style="left:${at(SL_CURRENT[0])};width:calc(${at(SL_CURRENT[1])} - ${at(SL_CURRENT[0])})" title="where the line operates today">current performance</span>` +
      `<span class="tick" style="left:${at(SL_STANDARD)}" title="common contact-centre target">industry standard</span>`;
    renderControlFeedback();
    loadFooter();
    refresh();
  }
  init();
  // Chrome may restore form state after scripts ran (reload, back/forward),
  // which would silently change the queue model or weighting under the
  // user. pageshow fires after that restore, so defaults are reasserted.
  window.addEventListener("pageshow", (e) => { if (e.persisted) init(); });
})();
