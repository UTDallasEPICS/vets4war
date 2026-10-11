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

process.stdout.write(JSON.stringify(out));
