/* Node-side checks for web/logic.js, driven by tests/test_web.py.
 * Prints one JSON object; the Python side asserts on it. No browser, no DOM:
 * everything the grid shows is derived in logic.js, so it is testable here. */
"use strict";
const path = require("path");
const fs = require("fs");
const L = require(path.join(__dirname, "..", "web", "logic.js"));

const out = {};

// 1. Three cap states are distinct, and the stylesheet styles each one.
out.capStates = { under: L.capState(6), at: L.capState(7), over: L.capState(8), undef: L.capState(null) };
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
out.capCssRules = ["cap-under", "cap-at", "cap-over"].map((cls) => (html.match(new RegExp(`\\.${cls}\\b`, "g")) || []).length);
out.legendEntries = (html.match(/data-legend="(under|at|over)"/g) || []).length;

// 2. Planned-roster persistence survives a simulated reload (new store on the
//    same backing storage) and a storage that throws.
function fakeStorage() {
  const data = {};
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, _data: data };
}
const backing = fakeStorage();
const first = L.createPlannedStore(backing);
first.set("2026-10-01", "Day", 6);
first.set("2026-10-02", "Evening", 9);
const reloaded = L.createPlannedStore(backing);          // simulated reload
out.persisted = { day: reloaded.get("2026-10-01", "Day"), evening: reloaded.get("2026-10-02", "Evening"), missing: reloaded.get("2026-10-03", "Day") };
reloaded.set("2026-10-01", "Day", null);
out.cleared = L.createPlannedStore(backing).get("2026-10-01", "Day");
const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
const guarded = L.createPlannedStore(throwing);
guarded.set("2026-10-01", "Day", 4);
out.throwingStorage = { get: guarded.get("2026-10-01", "Day"), size: guarded.size() };
out.nullStorage = L.createPlannedStore(null).get("2026-10-01", "Day");

// 3. CSV export: non-empty, expected header row, one line per hour.
function sampleWeek() {
  const hours = [], days = [];
  for (let d = 0; d < 7; d++) {
    const date = `2026-10-${String(5 + d).padStart(2, "0")}`;
    days.push({ date, is_weekend: d >= 5, holiday: d === 3 ? "Test Day" : null });
    for (let h = 0; h < 24; h++) {
      const shape = 4 + 5 * Math.max(0, Math.sin((h - 6) / 24 * Math.PI * 2 + 1));   // 4..9 calls, evening peak
      hours.push({ date, hour: h, predicted_calls: shape, aht_sec: 600 + 20 * (h % 5) });
    }
  }
  return { hours, days };
}
const c = { efficiency: 0.65, targetPct: 0.80, targetSec: 30, patienceSec: 256 };
const { hours, days } = sampleWeek();
const computed = L.computeHours(hours, c);
const judged = L.judgeRoster(L.rollupShifts(days, computed), L.createPlannedStore(fakeStorage()), c);
const csv = L.toCsv(L.csvRows(computed, judged));
const lines = csv.trim().split("\n");
out.csv = { header: lines[0], lineCount: lines.length, nonEmpty: csv.length > 0, sampleRow: lines[1] };

// 4. Recompute budget on the 168-hour grid: staffing + roll-up + roster verdicts
//    + summary, which is exactly what a slider move triggers.
function recompute() {
  const hrs = L.computeHours(hours, c);
  const rolled = L.judgeRoster(L.rollupShifts(days, hrs), L.createPlannedStore(fakeStorage()), c);
  const scale = L.discreteScale(hrs.map((h) => h.staff_to_schedule));
  const summary = L.summarize(hrs);
  const fewer = L.abandonedOneFewer(hrs, c);
  return { hrs, rolled, scale, summary, fewer };
}
recompute();                                             // warm-up
const t0 = process.hrtime.bigint();
const RUNS = 5;
let last;
for (let i = 0; i < RUNS; i++) last = recompute();
out.recomputeMs = Number(process.hrtime.bigint() - t0) / 1e6 / RUNS;
out.gridHours = last.hrs.length;
out.scale = { lo: last.scale.lo, hi: last.scale.hi, steps: last.scale.steps };
out.oneFewerRaises = last.fewer > last.summary.abandoned;
out.verdicts = L.VERDICTS;
out.sampleVerdict = last.rolled[0].planned.Day.verdict;

// 5. Verdict table and planned outcome direction.
out.verdictCases = { under: L.verdict(4, 5), on: L.verdict(5, 5), over: L.verdict(6, 5), beyond: L.verdict(8, 5) };
const dayRows = last.rolled[0].shifts.Day.hours;
const rec = last.rolled[0].shifts.Day.staff_needed;
out.plannedFewerLowersServiceLevel = L.plannedOutcome(dayRows, rec - 1, c).service_level < L.plannedOutcome(dayRows, rec, c).service_level;

// 6. Period report: covers exactly the selected window, one row per day,
//    totals equal L.summarize over the same hours, text is escaped, and an
//    undefined staffing value renders as "-" rather than a number.
const R = require(path.join(__dirname, "..", "web", "report.js"));
const reportInput = {
  start: "2026-10-05", end: "2026-10-11",
  settings: { efficiencyPct: 65, slPct: 80, targetSec: 30, patienceSec: 256 },
  sourceLabel: "Partner data <test>", caveat: "Forecast caveat.", generatedAt: "2026-10-18 12:00",
  hours: computed, days: judged,
};
const report = R.buildReport(reportInput);
const s = L.summarize(computed);
out.report = {
  hasPeriod: report.includes("2026-10-05") && report.includes("2026-10-11"),
  dayRows: (report.match(/data-day="/g) || []).length,
  totalCalls: (report.match(/data-total="calls">([^<]*)</) || [])[1],
  expectedCalls: Math.round(s.calls).toLocaleString("en-US"),
  totalPersonHours: (report.match(/data-total="person-hours">([^<]*)</) || [])[1],
  expectedPersonHours: s.personHours.toLocaleString("en-US"),
  escaped: report.includes("Partner data &lt;test&gt;") && !report.includes("<test>"),
  holidayShown: report.includes("Test Day"),
  isDocument: report.startsWith("<!doctype html>"),
};
const zeroEff = { ...c, efficiency: 0 };
const zeroHours = L.computeHours(hours, zeroEff);
const zeroDays = L.judgeRoster(L.rollupShifts(days, zeroHours), L.createPlannedStore(fakeStorage()), zeroEff);
const zeroReport = R.buildReport({ ...reportInput, settings: { ...reportInput.settings, efficiencyPct: 0 }, hours: zeroHours, days: zeroDays });
out.reportUndefined = (zeroReport.match(/data-total="person-hours">([^<]*)</) || [])[1];
let emptyError = null;
try { R.buildReport({ ...reportInput, hours: [], days: [] }); } catch (e) { emptyError = e.message; }
out.reportEmptyError = emptyError;

// Per-shift caps: Evening 6 (partner rule, 2026-10-21), others 7.
out.caps = {
  byHour: [0, 8, 16, 23].map((h) => L.capForHour(h)),
  eveningSevenVerdict: L.verdict(7, 7, L.capForShift("Evening")),
  daySevenVerdict: L.verdict(7, 7, L.capForShift("Day")),
  eveningHoursCarryCap: computed.filter((h) => h.hour >= 16).every((h) => h.cap === 6),
  eveningShiftCap: judged[0].shifts.Evening.cap,
};
// Fixed roster outcome: more people -> fewer hang-ups, higher service level.
const small = L.rosterOutcome(computed, { Overnight: 3, Day: 3, Evening: 4 }, c);
const real = L.rosterOutcome(computed, { Overnight: 4, Day: 4, Evening: 6 }, c);
out.roster = {
  callsMatch: Math.abs(real.calls - s.calls) < 1e-9,
  fewerHangups: real.abandoned < small.abandoned,
  betterService: real.serviceLevel > small.serviceLevel,
  inRange: real.abandonShare >= 0 && real.abandonShare <= 1 && real.serviceLevel >= 0 && real.serviceLevel <= 1,
  undefinedAtZeroEfficiency: L.rosterOutcome(computed, { Overnight: 4, Day: 4, Evening: 6 }, { ...c, efficiency: 0 }),
};

// Shift totals and the staff trade-off table (options 1 and 2).
const eve = judged[0].shifts.Evening;
const table = L.shiftTradeoff(eve.core_hours, eve.cap, c);
const t4 = L.shiftTotals(eve.core_hours, 4, c);
out.tradeoff = {
  rows: table.map((r) => r.staff),
  lostFallsWithStaff: table.every((r, i) => i === 0 || r.lost <= table[i - 1].lost + 1e-9),
  serviceRisesWithStaff: table.every((r, i) => i === 0 || r.serviceLevel >= table[i - 1].serviceLevel - 1e-9),
  partsAddUp: Math.abs(t4.lost + t4.inTime + t4.late - t4.calls) < 1e-6,
  coreCallsOnly: Math.abs(t4.calls - eve.predicted_calls) < 1e-9,
  plannedHasTotals: judged[0].planned.Evening.totals !== null,
  undefinedAtZeroEfficiency: L.shiftTotals(eve.core_hours, 4, { ...c, efficiency: 0 }),
};

process.stdout.write(JSON.stringify(out));
