// One-day board of the staffing console (the data half of final-main's web/dayfocus.js).
// When the page looks at a single day, the board lays that day out hour by hour: the
// call load, what the grid recommends, and what the roster on the sliders would
// deliver in the same hour. The roster rows run plannedOutcome on one hour at a time,
// the same chain the grid's roster cells use. The table and the phone list are
// components that render these specs.
import { plannedOutcome, shiftOfHour } from './logic'
import type { ComputedHour, Controls, PlannedOutcome, Roster } from './logic'

export const UNDEF = '-'
const MINUTES_PER_HOUR = 60
const SECONDS_PER_MINUTE = 60
// Tallest bar in the calls chart row, in px.
export const BAR_PX = 84

export const focusPct = (x: number | null | undefined) =>
  x === null || x === undefined ? UNDEF : `${Math.round(x * 100)}%`
export const whole = (x: number | null | undefined) =>
  x === null || x === undefined ? UNDEF : String(x)

export type AtRoster = PlannedOutcome & { staff: number }

// What the slider roster delivers in one hour.
export function atRoster(hour: ComputedHour, roster: Roster, c: Controls): AtRoster {
  const staff = roster[shiftOfHour(hour.hour)]
  return { staff, ...plannedOutcome([hour], staff, c) }
}

// True when a known service level falls short of the target.
export const misses = (level: number | null | undefined, c: Controls) =>
  level !== null && level !== undefined && level < c.targetPct

export interface FocusCell {
  text: string
  cls?: string
}
export type RowSpec =
  | { section: string; tone?: 'rec' | 'own' }
  | { label: string; cell: (h: ComputedHour, own: AtRoster) => FocusCell }

// One entry per table row.
export function rowSpecs(c: Controls): RowSpec[] {
  return [
    { section: 'Call load' },
    { label: 'Real calls', cell: (h) => ({ text: h.predicted_real_calls.toFixed(1) }) },
    {
      label: 'Talk time, minutes',
      cell: (h) => ({ text: String(Math.round(h.load_erlangs * MINUTES_PER_HOUR)) }),
    },
    {
      label: 'Average call, minutes',
      cell: (h) => ({ text: (h.aht_sec / SECONDS_PER_MINUTE).toFixed(1) }),
    },
    { section: 'As the grid recommends', tone: 'rec' },
    {
      label: 'People to schedule',
      cell: (h) => ({ text: whole(h.staff_to_schedule), cls: `staff cap-${h.cap_state}` }),
    },
    { label: 'On phones after efficiency', cell: (h) => ({ text: whole(h.effective_agents) }) },
    {
      label: `Answered within ${c.targetSec} s`,
      cell: (h) => ({
        text: focusPct(h.service_level_delivered),
        cls: misses(h.service_level_delivered, c) ? 'miss' : '',
      }),
    },
    { label: 'Hang-ups', cell: (h) => ({ text: focusPct(h.abandon_share) }) },
    { section: 'With your roster', tone: 'own' },
    { label: 'People on shift', cell: (h, own) => ({ text: whole(own.staff), cls: 'staff own' }) },
    {
      label: 'On phones after efficiency',
      cell: (h, own) => ({ text: whole(own.effective_agents) }),
    },
    {
      label: `Answered within ${c.targetSec} s`,
      cell: (h, own) => ({
        text: focusPct(own.service_level),
        cls: misses(own.service_level, c) ? 'miss' : '',
      }),
    },
    { label: 'Hang-ups', cell: (h, own) => ({ text: focusPct(own.abandon_share) }) },
  ]
}
