// Chart data of the staffing console (the data half of final-main's web/charts.js).
// Every figure comes from logic.ts run over a subset of the hours the page already
// computed (one shift, or one day), so a chart can never disagree with the headline
// numbers: the shift bars add up to the roster card, the day bars to the same totals.
import type { ShiftName } from '#shared/types/api'
import { SHIFTS, rosterOutcome, shiftOfHour, summarize } from './logic'
import type { ComputedHour, Controls, Roster } from './logic'

// Hours labelled under the hour bars of the detail sheet.
export const AXIS_HOURS = [0, 6, 12, 18, 23] as const

export interface Outcome {
  calls: number
  roster: number | null
  recommended: number | null
}

// Hang-ups over `hours` at the slider roster and at the grid's recommendation.
export function outcome(hours: ComputedHour[], roster: Roster, c: Controls): Outcome {
  const atRoster = rosterOutcome(hours, roster, c)
  const s = summarize(hours)
  return {
    calls: s.calls,
    roster: atRoster === null ? null : atRoster.abandoned,
    recommended: s.abandoned,
  }
}

// One row per shift: where in the day the hang-ups fall.
export function shiftSplit(
  hours: ComputedHour[],
  roster: Roster,
  c: Controls
): (Outcome & { name: ShiftName })[] {
  return SHIFTS.map((spec) => ({
    name: spec.name,
    ...outcome(
      hours.filter((h) => shiftOfHour(h.hour) === spec.name),
      roster,
      c
    ),
  }))
}

// One row per day: which days the roster struggles on.
export function daySplit(
  days: { date: string }[],
  hours: ComputedHour[],
  roster: Roster,
  c: Controls
): (Outcome & { date: string })[] {
  const byDate = new Map<string, ComputedHour[]>(days.map((d) => [d.date, []]))
  hours.forEach((h) => {
    const list = byDate.get(h.date)
    if (list) list.push(h)
  })
  return days.map((d) => ({ date: d.date, ...outcome(byDate.get(d.date)!, roster, c) }))
}

// Largest value across both series, so paired bars share one scale.
export function topOf(rows: { roster: number | null; recommended: number | null }[]): number {
  return Math.max(
    0,
    ...rows.flatMap((r) => [r.roster, r.recommended]).filter((v): v is number => v !== null)
  )
}

// Share of the scale a value fills, as a CSS percentage.
export function share(value: number | null, top: number): string {
  return `${value === null || !(top > 0) ? 0 : ((value / top) * 100).toFixed(1)}%`
}
