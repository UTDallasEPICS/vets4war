/* Pure functions behind the staffing grid. No DOM, no fetch.
 *
 * Loaded by index.html after erlang.js, and required under node by
 * tests/test_web.py. Everything the page displays is derived here from the
 * cached forecast (predicted calls + handle time per hour) and the control
 * values, so each number stays traceable and testable without a browser.
 */
const V4WUI = (() => {
  "use strict";
  const E = typeof V4W !== "undefined" ? V4W : require("./erlang.js");
  const MAX_STAFF_PER_SHIFT = E.MAX_STAFF_PER_SHIFT;
  const SECONDS_PER_HOUR = E.SECONDS_PER_HOUR;
  const HOURS = Array.from({ length: 24 }, (_, i) => i);

  // The partner's three tours. `core` hours are counted once (calls, person-
  // hours); the `boundary` hour is the 30-minute overlap at the tour's end and
  // joins the staffing peak of both adjacent tours but is never double-counted.
  // Evening's boundary is hour 0 of the NEXT date.
  // `cap` mirrors db/staffing.SHIFT_CAPS: the partner never staffs above 6
  // from 16:00 to midnight (2026-10-21 meeting).
  const EVENING_CAP = 6;
  const SHIFTS = [
    { name: "Overnight", short: "O", span: "00:00 to 08:30", core: HOURS.slice(0, 8), boundary: { hour: 8, nextDay: false }, cap: MAX_STAFF_PER_SHIFT },
    { name: "Day", short: "D", span: "08:00 to 16:30", core: HOURS.slice(8, 16), boundary: { hour: 16, nextDay: false }, cap: MAX_STAFF_PER_SHIFT },
    { name: "Evening", short: "E", span: "16:00 to 00:30", core: HOURS.slice(16, 24), boundary: { hour: 0, nextDay: true }, cap: EVENING_CAP },
  ];
  // Cap of the shift whose core hours contain `hour`.
  const capForHour = (hour) => SHIFTS.find((s) => s.core.includes(hour)).cap;
  const capForShift = (name) => SHIFTS.find((s) => s.name === name).cap;
  const SHIFT_NAMES = SHIFTS.map((s) => s.name);
  const VERDICTS = ["understaffed", "on target", "overstaffed", "exceeds capacity"];
  const PEAK_HOUR_COUNT = 4;          // hours underlined on the time axis
  const STORAGE_KEY = "v4w.planned.v1";

  const key = (date, hour) => `${date}:${hour}`;
  const shiftKey = (date, shift) => `${date}|${shift}`;

  // ---------------------------------------------------------------------------
  // Cap states. Three distinct situations with three distinct remedies:
  // under = fine; at = no headroom; over = the roster cannot do this.
  // ---------------------------------------------------------------------------
  function capState(staff, cap = MAX_STAFF_PER_SHIFT) {
    if (staff === null || staff === undefined) return "undef";
    if (staff > cap) return "over";
    if (staff === cap) return "at";
    return "under";
  }

  // Service level if an over-cap hour were clamped to its shift's cap: the
  // consequence of "we only have 6 (or 7)". The recommendation is never clamped.
  function clampedServiceLevel(row, c, cap = MAX_STAFF_PER_SHIFT) {
    const effective = Math.floor(cap * c.efficiency);
    return E.serviceLevel(effective, row.load_erlangs, row.aht_sec, c.targetSec, c.patienceSec);
  }

  // ---------------------------------------------------------------------------
  // Discrete colour scale: one step per integer across the observed under-cap
  // range. Four legible steps beat a gradient nobody can decode.
  // ---------------------------------------------------------------------------
  function discreteScale(staffValues) {
    const under = staffValues.filter((s) => capState(s) === "under");
    if (under.length === 0) return { lo: 0, hi: 0, steps: 1, levelOf: () => 0 };
    const lo = Math.min(...under), hi = Math.max(...under), steps = hi - lo + 1;
    const levelOf = (s) => (steps === 1 ? 1 : (s - lo) / (steps - 1));   // 0..1 in equal integer steps
    return { lo, hi, steps, levelOf };
  }

  // ---------------------------------------------------------------------------
  // Staffing for every hour, from the cached forecast and the controls.
  // ---------------------------------------------------------------------------
  function computeHours(baseHours, c) {
    return baseHours.map((h) => {
      const r = E.staffForHour(h.predicted_calls, h.aht_sec, c.efficiency, c.targetPct, c.targetSec, c.patienceSec);
      const cap = capForHour(h.hour);
      const state = capState(r.staff_to_schedule, cap);
      return {
        date: h.date, hour: h.hour, ...r, cap, cap_state: state,
        over_cap: r.staff_to_schedule === null ? r.over_cap : r.staff_to_schedule > cap,
        service_level_if_capped: state === "over" ? clampedServiceLevel(r, c, cap) : null,
      };
    });
  }

  // How many cells changed their recommendation between two recomputes.
  function diffCells(prev, next) {
    if (!prev || prev.length !== next.length) return next.length;
    let n = 0;
    for (let i = 0; i < next.length; i++) if (prev[i].staff_to_schedule !== next[i].staff_to_schedule) n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Shift roll-up. Mirrors db/staffing.rollup_shifts: staffing = max over core
  // hours plus the overlap hour; calls and person-hours = core hours only.
  // ---------------------------------------------------------------------------
  function shiftHours(byKey, date, nextDate, spec) {
    const core = spec.core.map((h) => byKey.get(key(date, h))).filter(Boolean);
    const bKey = spec.boundary.nextDay ? (nextDate ? key(nextDate, spec.boundary.hour) : null) : key(date, spec.boundary.hour);
    const all = bKey && byKey.has(bKey) ? [...core, byKey.get(bKey)] : core;
    return { core, all };
  }

  function rollupShifts(days, hours) {
    const byKey = new Map(hours.map((h) => [key(h.date, h.hour), h]));
    const dates = days.map((d) => d.date);
    return days.map((day, i) => {
      const shifts = {};
      SHIFTS.forEach((spec) => {
        const { core, all } = shiftHours(byKey, day.date, dates[i + 1], spec);
        const staff = all.map((r) => r.staff_to_schedule);
        const undefined_ = staff.some((s) => s === null) || all.length === 0;
        const peak = undefined_ ? null : Math.max(...staff);
        shifts[spec.name] = {
          predicted_calls: core.reduce((a, r) => a + r.predicted_calls, 0),
          agents_required: all.length ? Math.max(...all.map((r) => r.agents_required)) : 0,
          staff_needed: peak,
          cap: spec.cap,
          capped: peak === null ? null : peak > spec.cap,
          person_hours: undefined_ ? null : core.reduce((a, r) => a + r.staff_to_schedule, 0),
          service_level_delivered: undefined_ ? null : Math.min(...all.map((r) => r.service_level_delivered)),
          abandon_share: undefined_ || all.some((r) => r.abandon_share === null) ? null : Math.max(...all.map((r) => r.abandon_share)),
          hours: all,
          core_hours: core,
        };
      });
      const totals = Object.values(shifts).map((s) => s.person_hours);
      return { ...day, shifts, person_hours: totals.some((t) => t === null) ? null : totals.reduce((a, b) => a + b, 0) };
    });
  }

  // ---------------------------------------------------------------------------
  // Planned roster: the supervisor's number per (date, shift) against ours.
  // ---------------------------------------------------------------------------
  function verdict(planned, recommended, cap = MAX_STAFF_PER_SHIFT) {
    if (planned > cap) return "exceeds capacity";
    if (planned < recommended) return "understaffed";
    if (planned > recommended) return "overstaffed";
    return "on target";
  }

  // What `planned` people deliver for every hour of a shift: the same chain as
  // staffForHour evaluated at the supervisor's number. Worst hour reported.
  function plannedOutcome(rows, planned, c) {
    if (c.efficiency === 0 || rows.length === 0) return { effective_agents: null, service_level: null, abandon_share: null };
    const effective = Math.floor(planned * c.efficiency);
    const levels = rows.map((r) => E.serviceLevel(effective, r.load_erlangs, r.aht_sec, c.targetSec, c.patienceSec));
    const abandons = rows.map((r) => E.abandonShare(effective, r.load_erlangs, r.aht_sec, c.targetSec, c.patienceSec));
    const known = abandons.filter((a) => a !== null);
    return { effective_agents: effective, service_level: Math.min(...levels), abandon_share: known.length ? Math.max(...known) : null };
  }

  // Persistence for planned values. Only the supervisor's own entries are
  // stored (never our defaults), so untouched shifts keep following the
  // recommendation when controls change. Every storage call is guarded: a
  // private window or a blocked origin must not break the page.
  function createPlannedStore(storage) {
    function read() {
      try {
        const raw = storage && storage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (_) { return {}; }
    }
    function write(data) {
      try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* storage unavailable: in-memory only */ }
    }
    let memory = read();
    return {
      get(date, shift) { const v = memory[shiftKey(date, shift)]; return Number.isInteger(v) ? v : null; },
      set(date, shift, value) {
        const next = { ...memory };
        if (value === null || value === undefined) delete next[shiftKey(date, shift)]; else next[shiftKey(date, shift)] = value;
        memory = next; write(next);
      },
      clear() { memory = {}; write({}); },
      size() { return Object.keys(memory).length; },
    };
  }

  // What `staff` people deliver over a shift's CORE hours (each call counted
  // once), in calls, not just shares. Per hour: floor(staff x efficiency) on
  // inbound, Erlang A. serviceLevel = share of ALL calls answered within the
  // target; answeredLate = answered, but after the target; lost = hung up.
  function shiftTotals(coreHours, staff, c) {
    if (c.patienceSec === null || c.efficiency === 0 || !coreHours || coreHours.length === 0 || staff === null) return null;
    const effective = Math.floor(staff * c.efficiency);
    let calls = 0, lost = 0, inTime = 0;
    coreHours.forEach((h) => {
      calls += h.predicted_calls;
      lost += h.predicted_calls * E.abandonShare(effective, h.load_erlangs, h.aht_sec, c.targetSec, c.patienceSec);
      inTime += h.predicted_calls * E.serviceLevel(effective, h.load_erlangs, h.aht_sec, c.targetSec, c.patienceSec);
    });
    const late = Math.max(0, calls - lost - inTime);
    return { staff, effective, calls, lost, inTime, late,
      lostShare: calls > 0 ? lost / calls : null, serviceLevel: calls > 0 ? inTime / calls : null };
  }

  // One shiftTotals row per staff number from `minStaff` to the shift cap:
  // the "what does 4 vs 5 vs 6 cost" table.
  const TRADEOFF_MIN_STAFF = 1;
  function shiftTradeoff(coreHours, cap, c, minStaff = TRADEOFF_MIN_STAFF) {
    const rows = [];
    for (let n = minStaff; n <= cap; n++) {
      const t = shiftTotals(coreHours, n, c);
      if (t === null) return [];
      rows.push(t);
    }
    return rows;
  }

  // Planned value + verdict + consequence for every shift of every day.
  function judgeRoster(rolled, store, c) {
    return rolled.map((day) => {
      const judged = {};
      SHIFT_NAMES.forEach((name) => {
        const s = day.shifts[name];
        const rec = s.staff_needed;
        const own = store.get(day.date, name);
        const planned = own !== null ? own : rec;
        judged[name] = rec === null || planned === null
          ? { planned, recommended: rec, delta: null, verdict: null, is_own: own !== null, service_level: null, abandon_share: null, effective_agents: null }
          : { planned, recommended: rec, delta: planned - rec, verdict: verdict(planned, rec, capForShift(name)), is_own: own !== null, ...plannedOutcome(s.hours, planned, c),
              totals: shiftTotals(s.core_hours, planned, c), recommendedTotals: shiftTotals(s.core_hours, rec, c) };
      });
      return { ...day, planned: judged };
    });
  }

  // ---------------------------------------------------------------------------
  // Summaries: whole window, a drag selection, or one day.
  // ---------------------------------------------------------------------------
  function summarize(hours) {
    const calls = hours.reduce((a, h) => a + h.predicted_calls, 0);
    const talkSec = hours.reduce((a, h) => a + h.load_erlangs * SECONDS_PER_HOUR, 0);
    const staffed = hours.map((h) => h.staff_to_schedule);
    const personHours = staffed.some((s) => s === null) ? null : staffed.reduce((a, s) => a + s, 0);
    const peakStaff = staffed.some((s) => s === null) || !staffed.length ? null : Math.max(...staffed);
    const known = hours.filter((h) => h.abandon_share !== null);
    const abandoned = known.length ? known.reduce((a, h) => a + h.predicted_calls * h.abandon_share, 0) : null;
    return { n: hours.length, calls, talkSec, meanAht: calls > 0 ? talkSec / calls : null, personHours, peakStaff, abandoned };
  }

  // Expected abandoned calls if every hour scheduled ONE FEWER person. Mirrors
  // api.main._abandoned_one_fewer. This is what the slack buys.
  function abandonedOneFewer(hours, c) {
    if (c.patienceSec === null || c.efficiency === 0 || hours.some((h) => h.staff_to_schedule === null)) return null;
    return hours.reduce((a, h) => {
      const effective = Math.floor(Math.max(h.staff_to_schedule - 1, 0) * c.efficiency);
      return a + h.predicted_calls * E.abandonShare(effective, h.load_erlangs, h.aht_sec, c.targetSec, c.patienceSec);
    }, 0);
  }

  // What a FIXED roster delivers over the window: every hour gets the roster
  // number of the shift whose core hours contain it (the partner's real
  // 4/4/6 by default). Same chain as everything else: floor(staff x
  // efficiency) on inbound, Erlang A for hang-ups and answered-in-time.
  // Validated on Oct 14-20 2026: model 77.8% / 13.5% vs actual 78.1% / 14.3%.
  function rosterOutcome(hours, roster, c) {
    if (c.patienceSec === null || c.efficiency === 0 || hours.length === 0) return null;
    let calls = 0, abandoned = 0, answered = 0;
    hours.forEach((h) => {
      const shift = SHIFTS.find((s) => s.core.includes(h.hour)).name;
      const effective = Math.floor(roster[shift] * c.efficiency);
      calls += h.predicted_calls;
      abandoned += h.predicted_calls * E.abandonShare(effective, h.load_erlangs, h.aht_sec, c.targetSec, c.patienceSec);
      answered += h.predicted_calls * E.serviceLevel(effective, h.load_erlangs, h.aht_sec, c.targetSec, c.patienceSec);
    });
    return { calls, abandoned, abandonShare: calls > 0 ? abandoned / calls : null, serviceLevel: calls > 0 ? answered / calls : null };
  }

  function dayStats(day, dayHours) {
    const s = summarize(dayHours);
    const peakHour = dayHours.length ? dayHours.reduce((a, b) => (b.predicted_calls > a.predicted_calls ? b : a)) : null;
    return {
      ...s,
      peakHour: peakHour ? peakHour.hour : null,
      atCap: dayHours.filter((h) => h.cap_state === "at").map((h) => h.hour),
      overCap: dayHours.filter((h) => h.cap_state === "over").map((h) => h.hour),
      shifts: day.shifts, planned: day.planned,
    };
  }

  // Hours of the day that carry the most calls across the loaded window.
  function peakHours(hours, count = PEAK_HOUR_COUNT) {
    const sum = new Array(24).fill(0), n = new Array(24).fill(0);
    hours.forEach((h) => { sum[h.hour] += h.predicted_calls; n[h.hour] += 1; });
    return HOURS.filter((h) => n[h] > 0).map((h) => [h, sum[h] / n[h]]).sort((a, b) => b[1] - a[1]).slice(0, count).map(([h]) => h);
  }

  // ---------------------------------------------------------------------------
  // CSV export: the full hourly table plus the shift's planned value and
  // verdict on every hour of that shift. Values are unrounded.
  // ---------------------------------------------------------------------------
  const CSV_COLUMNS = ["date", "hour", "shift", "predicted_calls", "aht_sec", "load_erlangs", "agents_required",
    "staff_to_schedule", "effective_agents", "service_level_delivered", "abandon_share", "cap_state",
    "service_level_if_capped", "planned_shift_staff", "verdict", "service_level_at_planned"];

  function shiftOfHour(hour) { return SHIFTS.find((s) => s.core.includes(hour)).name; }

  function csvRows(hours, judgedDays) {
    const byDate = new Map(judgedDays.map((d) => [d.date, d]));
    return hours.map((h) => {
      const name = shiftOfHour(h.hour);
      const day = byDate.get(h.date);
      const p = day && day.planned ? day.planned[name] : null;
      return {
        date: h.date, hour: h.hour, shift: name, predicted_calls: h.predicted_calls, aht_sec: h.aht_sec,
        load_erlangs: h.load_erlangs, agents_required: h.agents_required, staff_to_schedule: h.staff_to_schedule,
        effective_agents: h.effective_agents, service_level_delivered: h.service_level_delivered,
        abandon_share: h.abandon_share, cap_state: h.cap_state, service_level_if_capped: h.service_level_if_capped,
        planned_shift_staff: p ? p.planned : null, verdict: p ? p.verdict : null, service_level_at_planned: p ? p.service_level : null,
      };
    });
  }

  function csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCsv(rows, columns = CSV_COLUMNS) {
    const lines = [columns.join(",")];
    rows.forEach((r) => lines.push(columns.map((c) => csvCell(r[c])).join(",")));
    return lines.join("\n") + "\n";
  }

  return { HOURS, SHIFTS, SHIFT_NAMES, VERDICTS, CSV_COLUMNS, STORAGE_KEY, MAX_STAFF_PER_SHIFT, EVENING_CAP, SECONDS_PER_HOUR,
    key, shiftKey, capForHour, capForShift, capState, clampedServiceLevel, discreteScale, computeHours, diffCells, rollupShifts, verdict,
    plannedOutcome, createPlannedStore, judgeRoster, summarize, abandonedOneFewer, rosterOutcome, shiftTotals, shiftTradeoff, dayStats, peakHours,
    shiftOfHour, csvRows, toCsv };
})();

if (typeof module !== "undefined" && module.exports) module.exports = V4WUI;
