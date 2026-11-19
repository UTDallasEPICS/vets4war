// Printable period report of the staffing console (final-main's web/report.js,
// unchanged output). buildReport(input) returns a complete HTML document for the
// selected period. Every number is derived from the hours and days the page already
// computed (logic.ts), so the report always matches the grid and the CSV for the same
// settings. The page opens it in a new window and calls print, which lets the person
// save it as a PDF.
import type { ShiftName } from '#shared/types/api'
import { EVENING_CAP, MAX_STAFF_PER_SHIFT, SHIFTS, SHIFT_NAMES, dayStats, summarize } from './logic'
import type { ComputedHour, JudgedDay, PlannedShift } from './logic'

const UNDEF = '-'
// Fixed so the report reads the same on every machine.
const LOCALE = 'en-US'
const SECONDS_PER_MINUTE = 60

export interface ReportInput {
  start: string
  end: string
  settings: { efficiencyPct: number; slPct: number; targetSec: number; patienceSec: number | null }
  sourceLabel: string
  caveat: string
  generatedAt: string
  hours: ComputedHour[]
  days: JudgedDay<{ date: string; holiday?: string | null }>[]
}

const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
const num = (x: number | null | undefined) =>
  x === null || x === undefined ? UNDEF : Math.round(x).toLocaleString(LOCALE)
const pct = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined ? UNDEF : `${(x * 100).toFixed(d)}%`
const pad2 = (n: number) => String(n).padStart(2, '0')

function hoursLabel(sec: number): string {
  const minutes = Math.round(sec / SECONDS_PER_MINUTE)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h.toLocaleString(LOCALE)}h ${m}m` : `${m}m`
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(LOCALE, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

// One roster cell: the recommended number, plus the planner's own number and verdict
// if they set one.
function shiftCell(p: PlannedShift | undefined): string {
  if (!p || p.recommended === null) return UNDEF
  if (!p.is_own) return esc(p.recommended)
  return `${esc(p.planned)} planned<br><small>${esc(p.recommended)} rec · ${esc(p.verdict)}</small>`
}

function dayRow(day: ReportInput['days'][number], dayHours: ComputedHour[]): string {
  const st = dayStats(day, dayHours)
  const flags: string[] = []
  if (day.holiday) flags.push(esc(day.holiday))
  if (st.overCap.length) flags.push(`over cap ${st.overCap.map(pad2).join(', ')}h`)
  else if (st.atCap.length) flags.push(`at cap ${st.atCap.length} h`)
  const cells = SHIFT_NAMES.map(
    (name: ShiftName) => `<td class="n">${shiftCell(day.planned[name])}</td>`
  ).join('')
  return (
    `<tr data-day="${esc(day.date)}"><td>${esc(dayLabel(day.date))}</td><td class="n">${num(st.calls)}</td>${cells}` +
    `<td class="n">${num(st.personHours)}</td><td class="n">${num(st.abandoned)}</td><td class="flag">${flags.join(' · ')}</td></tr>`
  )
}

function capCounts(hours: ComputedHour[]): { at: number; over: number } {
  return {
    at: hours.filter((h) => h.cap_state === 'at').length,
    over: hours.filter((h) => h.cap_state === 'over').length,
  }
}

function stat(label: string, value: string, note: string, key: string): string {
  return `<div class="stat"><div class="k">${esc(label)}</div><div class="v" data-total="${key}">${value}</div><div class="d">${esc(note)}</div></div>`
}

const STYLE = `
    @page { size: letter landscape; margin: 0.5in; }
    * { box-sizing: border-box; }
    body { font: 11px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0f172a; background: #fff; margin: 24px; }
    h1 { font-size: 18px; margin: 0 0 2px; } .sub { color: #475569; margin: 0 0 14px; }
    .stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 14px; }
    .stat { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; }
    .k { color: #475569; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    .v { font-size: 18px; font-weight: 600; } .d { color: #64748b; font-size: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1f3a5f; color: #fff; text-align: left; font-weight: 600; padding: 5px 6px; }
    td { border-bottom: 1px solid #e2e8f0; padding: 4px 6px; vertical-align: top; }
    tr:nth-child(even) td { background: #f8fafc; } tr { page-break-inside: avoid; }
    .n { text-align: right; font-variant-numeric: tabular-nums; } th.n { text-align: right; }
    .flag { color: #b45309; } small { color: #64748b; }
    .foot { color: #64748b; font-size: 10px; margin-top: 12px; }
    @media print { body { margin: 0; } }`

// A complete HTML document for the selected period. Throws on an empty window.
export function buildReport(input: ReportInput): string {
  if (!input || !Array.isArray(input.hours) || input.hours.length === 0) {
    throw new Error('no forecast hours in the selected period')
  }
  if (!Array.isArray(input.days) || input.days.length === 0) {
    throw new Error('no forecast days in the selected period')
  }
  const { start, end, settings, hours, days } = input
  const s = summarize(hours)
  const caps = capCounts(hours)
  const byDate = new Map(days.map((d) => [d.date, hours.filter((h) => h.date === d.date)]))
  const shiftHeads = SHIFTS.map(
    (sp) =>
      `<th class="n">${esc(sp.name)}<br><small style="color:#cbd5e1">${esc(sp.span)}</small></th>`
  ).join('')
  const rows = days.map((d) => dayRow(d, byDate.get(d.date)!)).join('')
  const capNote = caps.over
    ? `${caps.over} h over the shift cap (${MAX_STAFF_PER_SHIFT}; Evening ${EVENING_CAP})`
    : caps.at
      ? `${caps.at} h at the cap`
      : 'No hour reaches the cap'

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(`V4W staffing report ${start} to ${end}`)}</title><style>${STYLE}</style></head><body>
<h1>Vets4Warriors staffing report</h1>
<p class="sub">${esc(start)} to ${esc(end)} · ${days.length} days · efficiency ${esc(settings.efficiencyPct)}% · ${esc(settings.slPct)}% answered within ${esc(settings.targetSec)} s · ${esc(input.sourceLabel || '')} · generated ${esc(input.generatedAt)}</p>
<div class="stats">
${stat('Predicted calls', num(s.calls), `${s.n.toLocaleString(LOCALE)} hours`, 'calls')}
${stat('Person-hours to schedule', num(s.personHours), 'Every hour, added up', 'person-hours')}
${stat('Peak people in one hour', num(s.peakStaff), capNote, 'peak')}
${stat('Expected hang-ups', num(s.abandoned), s.abandoned === null || s.calls === 0 ? 'Undefined at 0% efficiency' : `${pct(s.abandoned / s.calls)} of calls, at recommended staffing`, 'abandoned')}
${stat('Expected talk time', esc(hoursLabel(s.talkSec)), `Average call ${s.meanAht === null ? UNDEF : (s.meanAht / SECONDS_PER_MINUTE).toFixed(1)} min`, 'talk')}
</div>
<table><thead><tr><th>Day</th><th class="n">Calls</th>${shiftHeads}<th class="n">Person-hours</th><th class="n">Hang-ups</th><th>Notes</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="foot">Shift columns show people to schedule at the shift's busiest hour; "planned" appears where a supervisor entered their own number. ${esc(input.caveat || '')}${settings.patienceSec ? ` Callers are assumed to give up after ${Math.round(settings.patienceSec)} s on average.` : ''}</p>
</body></html>`
}
