/* Chart data and markup for the staffing console. Pure: no DOM, no fetch.
 *
 * Every figure here comes from web/logic.js run over a subset of the hours
 * the page already computed (one shift, or one day), so a chart can never
 * disagree with the headline numbers: the shift bars add up to the roster
 * card, and the day bars add up to the same totals.
 *
 * Loaded by index.html after logic.js and before app.js.
 */
const V4WCharts = (() => {
  "use strict";
  const L = typeof V4WUI !== "undefined" ? V4WUI : require("./logic.js");
  const AXIS_HOURS = [0, 6, 12, 18, 23];
  const pad2 = (n) => String(n).padStart(2, "0");

  /** Hang-ups over `hours` at the slider roster and at the grid's recommendation. */
  function outcome(hours, roster, c) {
    const atRoster = L.rosterOutcome(hours, roster, c);
    const s = L.summarize(hours);
    return { calls: s.calls, roster: atRoster === null ? null : atRoster.abandoned, recommended: s.abandoned };
  }

  /** One row per shift: where in the day the hang-ups fall. */
  function shiftSplit(hours, roster, c) {
    return L.SHIFTS.map((spec) => ({ name: spec.name, ...outcome(hours.filter((h) => L.shiftOfHour(h.hour) === spec.name), roster, c) }));
  }

  /** One row per day: which days the roster struggles on. */
  function daySplit(days, hours, roster, c) {
    const byDate = new Map(days.map((d) => [d.date, []]));
    hours.forEach((h) => { const list = byDate.get(h.date); if (list) list.push(h); });
    return days.map((d) => ({ date: d.date, ...outcome(byDate.get(d.date), roster, c) }));
  }

  /** Largest value across both series, so paired bars share one scale. */
  function topOf(rows) {
    return Math.max(0, ...rows.flatMap((r) => [r.roster, r.recommended]).filter((v) => v !== null));
  }

  /** Share of the scale a value fills, as a CSS percentage. */
  function share(value, top) {
    return `${value === null || !(top > 0) ? 0 : (value / top * 100).toFixed(1)}%`;
  }

  /**
   * Predicted calls for each hour of one day, coloured by the hour's cap state.
   * @param {object[]} dayHours computed hours of a single date
   * @param {number|null} activeHour hour to mark, or null
   * @returns {string} markup
   */
  function hourBars(dayHours, activeHour = null) {
    if (dayHours.length === 0) return "";
    const top = Math.max(0, ...dayHours.map((h) => h.predicted_calls));
    const bars = dayHours.map((h) =>
      `<i class="hb cap-${h.cap_state}${h.hour === activeHour ? " on" : ""}" style="height:${share(h.predicted_calls, top)}" ` +
      `title="${pad2(h.hour)}:00, ${h.predicted_calls.toFixed(1)} calls"></i>`).join("");
    const axis = AXIS_HOURS.map((h) => `<span style="left:${(h / 23 * 100).toFixed(2)}%">${pad2(h)}</span>`).join("");
    return `<div class="hourchart"><div class="hourbars" role="img" aria-label="Predicted calls for each hour of the day, busiest ${top.toFixed(1)} calls">${bars}</div>` +
      `<div class="houraxis" aria-hidden="true">${axis}</div></div>`;
  }

  /**
   * Phone layout of the day-by-day view: one tappable row per day with its
   * calls, the roster number for each shift and the hang-ups either way.
   * @param {object[]} judgedDays days with shift roll-up and planned verdicts (L.judgeRoster)
   * @param {object[]} rows daySplit() output for the same days
   * @param {(date: string) => {weekday: string, date: string}} labelOf formats a date for display
   * @returns {string} markup
   */
  function dayList(judgedDays, rows, labelOf) {
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const lost = (v) => (v === null || v === undefined ? "-" : Math.round(v).toLocaleString());
    const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const head = `<div class="dhead" aria-hidden="true"><span>Day</span><span class="dchips">${L.SHIFTS.map((s) => `<i>${s.name === "Overnight" ? "Night" : s.name === "Evening" ? "Eve" : s.name}</i>`).join("")}</span><span>Hang-ups</span></div>`;
    const body = judgedDays.map((day) => {
      const row = byDate.get(day.date) || { calls: 0, roster: null, recommended: null };
      const when = labelOf(day.date);
      const chips = L.SHIFTS.map((spec) => {
        const s = day.shifts[spec.name], p = day.planned[spec.name];
        return `<i class="chip-s cap-${L.capState(s.staff_needed, s.cap)}${p.is_own ? " own" : ""}">${p.planned === null ? "-" : p.planned}</i>`;
      }).join("");
      const cls = ["drow", day.is_weekend ? "weekend" : "", day.holiday ? "holiday" : ""].join(" ").trim();
      return `<button type="button" class="${cls}" data-day="${day.date}">` +
        `<span class="dd"><b>${esc(when.weekday)}</b> ${esc(when.date)}<small>${lost(row.calls)} calls${day.holiday ? `, ${esc(day.holiday)}` : ""}</small></span>` +
        `<span class="dchips">${chips}</span>` +
        `<span class="dlost"><b>${lost(row.roster)}</b><small>${lost(row.recommended)} recommended</small></span></button>`;
    }).join("");
    return head + body;
  }

  return { shiftSplit, daySplit, topOf, share, hourBars, dayList };
})();

if (typeof module !== "undefined" && module.exports) module.exports = V4WCharts;
