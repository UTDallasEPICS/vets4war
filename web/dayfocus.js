/* One-day board for the staffing console. Pure: no DOM, no fetch.
 *
 * When the page looks at a single day, this lays that day out hour by hour:
 * the call load, what the grid recommends, and what the roster on the
 * sliders would deliver in the same hour. Every figure comes from the hours
 * the page already computed (web/logic.js); the roster rows run
 * L.plannedOutcome on one hour at a time, the same chain the grid's roster
 * cells use.
 *
 * Loaded by index.html after logic.js and before app.js.
 */
const V4WDayFocus = (() => {
  "use strict";
  const L = typeof V4WUI !== "undefined" ? V4WUI : require("./logic.js");
  const UNDEF = "-";
  const MINUTES_PER_HOUR = 60, SECONDS_PER_MINUTE = 60;
  const BAR_PX = 84;                 // tallest bar in the calls chart row
  const pad2 = (n) => String(n).padStart(2, "0");
  const pct = (x) => (x === null || x === undefined ? UNDEF : `${Math.round(x * 100)}%`);
  const whole = (x) => (x === null || x === undefined ? UNDEF : String(x));

  /** What the slider roster delivers in one hour. */
  function atRoster(hour, roster, c) {
    const staff = roster[L.shiftOfHour(hour.hour)];
    return { staff, ...L.plannedOutcome([hour], staff, c) };
  }

  /** True when a known service level falls short of the target. */
  const misses = (level, c) => level !== null && level !== undefined && level < c.targetPct;

  // One entry per table row. `cell` returns { text, cls }.
  function rowSpecs(c) {
    return [
      { section: "Call load" },
      { label: "Real calls", cell: (h) => ({ text: h.predicted_real_calls.toFixed(1) }) },
      { label: "Talk time, minutes", cell: (h) => ({ text: String(Math.round(h.load_erlangs * MINUTES_PER_HOUR)) }) },
      { label: "Average call, minutes", cell: (h) => ({ text: (h.aht_sec / SECONDS_PER_MINUTE).toFixed(1) }) },
      { section: "As the grid recommends", tone: "rec" },
      { label: "People to schedule", cell: (h) => ({ text: whole(h.staff_to_schedule), cls: `staff cap-${h.cap_state}` }) },
      { label: "On phones after efficiency", cell: (h) => ({ text: whole(h.effective_agents) }) },
      { label: `Answered within ${c.targetSec} s`, cell: (h) => ({ text: pct(h.service_level_delivered), cls: misses(h.service_level_delivered, c) ? "miss" : "" }) },
      { label: "Hang-ups", cell: (h) => ({ text: pct(h.abandon_share) }) },
      { section: "With your roster", tone: "own" },
      { label: "People on shift", cell: (h, own) => ({ text: whole(own.staff), cls: "staff own" }) },
      { label: "On phones after efficiency", cell: (h, own) => ({ text: whole(own.effective_agents) }) },
      { label: `Answered within ${c.targetSec} s`, cell: (h, own) => ({ text: pct(own.service_level), cls: misses(own.service_level, c) ? "miss" : "" }) },
      { label: "Hang-ups", cell: (h, own) => ({ text: pct(own.abandon_share) }) },
    ];
  }

  /**
   * @param {object[]} dayHours computed hours of one date, in hour order
   * @param {{Overnight:number, Day:number, Evening:number}} roster the slider roster
   * @param {object} c controls (efficiency, targetPct, targetSec, patienceSec)
   * @returns {string} table markup, or "" when there are no hours
   */
  function build(dayHours, roster, c) {
    if (dayHours.length === 0) return "";
    const top = Math.max(0, ...dayHours.map((h) => h.predicted_calls));
    const own = new Map(dayHours.map((h) => [h.hour, atRoster(h, roster, c)]));
    const tours = L.SHIFTS.map((spec) => ({ spec, hours: dayHours.filter((h) => spec.core.includes(h.hour)) })).filter((t) => t.hours.length > 0);
    const firstOfTour = new Set(tours.map((t) => t.hours[0].hour));
    const edge = (h) => (firstOfTour.has(h.hour) ? " edge" : "");
    const attrs = (h) => `data-k="${L.key(h.date, h.hour)}"`;

    const cols = `<col class="f-label">${dayHours.map(() => "<col>").join("")}`;
    const groups = `<tr class="f-groups"><th></th>${tours.map((t) =>
      `<th class="edge" colspan="${t.hours.length}">${t.spec.name}<small>${t.spec.span}</small></th>`).join("")}</tr>`;
    const chart = `<tr class="f-chart"><th>Predicted calls</th>${dayHours.map((h) =>
      `<td class="${edge(h).trim()}" ${attrs(h)} title="${pad2(h.hour)}:00, ${h.predicted_calls.toFixed(1)} calls predicted">` +
      `<span class="fv">${h.predicted_calls.toFixed(1)}</span><i style="height:${top > 0 ? Math.round(h.predicted_calls / top * BAR_PX) : 0}px"></i></td>`).join("")}</tr>`;
    const hours = `<tr class="f-hours"><th></th>${dayHours.map((h) => `<td class="${edge(h).trim()}" ${attrs(h)}>${pad2(h.hour)}</td>`).join("")}</tr>`;

    const body = rowSpecs(c).map((spec) => {
      if (spec.section) return `<tr class="f-section ${spec.tone || ""}"><th colspan="${dayHours.length + 1}"><span>${spec.section}</span></th></tr>`;
      const cells = dayHours.map((h) => {
        const { text, cls = "" } = spec.cell(h, own.get(h.hour));
        return `<td class="${`${cls}${edge(h)}`.trim()}" ${attrs(h)}>${text}</td>`;
      }).join("");
      return `<tr><th>${spec.label}</th>${cells}</tr>`;
    }).join("");

    return `<table class="focus"><colgroup>${cols}</colgroup><thead>${groups}${chart}${hours}</thead><tbody>${body}</tbody></table>`;
  }

  /**
   * Phone layout of the one-day board: hours run down the screen. Each row is
   * the hour, its predicted calls, the recommended staff with the service
   * level it gives, and the slider roster with the service level it gives.
   * @returns {string} markup, or "" when there are no hours
   */
  function buildList(dayHours, roster, c) {
    if (dayHours.length === 0) return "";
    const top = Math.max(0, ...dayHours.map((h) => h.predicted_calls));
    const tours = L.SHIFTS.map((spec) => ({ spec, hours: dayHours.filter((h) => spec.core.includes(h.hour)) })).filter((t) => t.hours.length > 0);
    const row = (h) => {
      const own = atRoster(h, roster, c);
      return `<button type="button" class="hrow" data-k="${L.key(h.date, h.hour)}">` +
        `<span class="hh">${pad2(h.hour)}</span>` +
        `<span class="hcalls"><i style="width:${top > 0 ? (h.predicted_calls / top * 100).toFixed(1) : 0}%"></i><b>${h.predicted_calls.toFixed(1)}</b></span>` +
        `<span class="hpair${misses(h.service_level_delivered, c) ? " miss" : ""}"><i class="chip-s cap-${h.cap_state}">${whole(h.staff_to_schedule)}</i><small>${pct(h.service_level_delivered)}</small></span>` +
        `<span class="hpair${misses(own.service_level, c) ? " miss" : ""}"><i class="chip-s ownroster">${whole(own.staff)}</i><small>${pct(own.service_level)}</small></span></button>`;
    };
    const head = `<div class="hhead" aria-hidden="true"><span>Hour</span><span>Calls</span><span>Recommended</span><span>Your roster</span></div>`;
    return head + tours.map((t) => `<h3 class="htour">${t.spec.name}<small>${t.spec.span}</small></h3>${t.hours.map(row).join("")}`).join("");
  }

  return { build, buildList, atRoster };
})();

if (typeof module !== "undefined" && module.exports) module.exports = V4WDayFocus;
