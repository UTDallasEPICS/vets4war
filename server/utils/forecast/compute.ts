// The arithmetic of the forecast answers: final-main's api/main.py and the range part of
// db/staffing.py (staff_for_range, shift_memberships, rollup_shifts, planned_outcome,
// resolve_patience), ported line for line onto the stored forecast. Pure: no database.
// The per-hour Erlang chain is shared/utils/staffing.ts (pinned to the Python by P1).
import { SECONDS_PER_HOUR } from '#shared/utils/erlang'
import { formatDuration, pyRound } from '#shared/utils/format'
import { addDays, isoWeekday } from '#shared/utils/dates'
import { TALK_TIME_CAVEAT } from '#shared/utils/constants'
import {
  SHIFTS,
  abandonShare,
  capForHour,
  capForShift,
  plannedOutcome,
  staffForHour,
  verdict,
} from '#shared/utils/staffing'
import type {
  ForecastDay,
  HolidayCoverage,
  HourRow,
  PatienceSource,
  PlannedShiftResult,
  ShiftName,
  ShiftRollup,
  StaffingDay,
  WindowSummary,
} from '#shared/types/api'
import { apiError } from '../http'
import type { ForecastInput, PlannedInput } from './params'
import { cellIndex, type ForecastSnapshot, type ForecastStateRow } from './store'

// ISO weekday of Saturday: is_weekend = weekday >= 6.
const SATURDAY = 6

const talkSeconds = (loadErlangs: number) => loadErlangs * SECONDS_PER_HOUR

function sum(values: Iterable<number>): number {
  let total = 0
  for (const v of values) total += v
  return total
}

// db/staffing.py resolve_patience + api/main.py _queue_params: the patience the answer
// uses and where it came from. Erlang C has none.
export function resolvePatience(
  input: Pick<ForecastInput, 'queueModel' | 'patienceSec'>,
  state: Pick<ForecastStateRow, 'patienceSec' | 'patienceNAbandoned' | 'patienceNCalls'>
): { patienceSec: number | null; source: PatienceSource | null } {
  if (input.queueModel === 'erlang_c') return { patienceSec: null, source: null }
  if (input.patienceSec !== null) {
    return { patienceSec: input.patienceSec, source: { kind: 'override' } }
  }
  return {
    patienceSec: state.patienceSec,
    source: {
      kind: 'estimated',
      n_abandoned: state.patienceNAbandoned,
      n_calls: state.patienceNCalls,
    },
  }
}

// staff_for_range + _hour_rows: one row per stored hour with the whole chain, unrounded.
export function hourRows(
  snapshot: Pick<ForecastSnapshot, 'hours' | 'cells'>,
  input: Pick<
    ForecastInput,
    'efficiency' | 'targetPct' | 'targetSec' | 'recency' | 'includeHolidays'
  >,
  patienceSec: number | null
): HourRow[] {
  const cells = snapshot.cells[input.recency]
  const weekday = new Map<string, number>()
  return snapshot.hours.map((stored) => {
    let dow = weekday.get(stored.date)
    if (dow === undefined) {
      dow = isoWeekday(stored.date)
      weekday.set(stored.date, dow)
    }
    const cell = cells[cellIndex(dow, stored.hour)]
    if (!cell) throw new RangeError(`no handle-time cell for ${stored.date} ${stored.hour}`)
    const calls = input.includeHolidays ? stored.predictedCalls : stored.predictedCallsNoHolidays
    const s = staffForHour(
      calls,
      cell.ahtSec,
      input.efficiency,
      input.targetPct,
      input.targetSec,
      patienceSec,
      capForHour(stored.hour)
    )
    const talk = talkSeconds(s.load_erlangs)
    return {
      date: stored.date,
      hour: stored.hour,
      predicted_calls: calls,
      predicted_real_calls: calls * cell.realShare,
      aht_sec: s.aht_sec,
      load_erlangs: s.load_erlangs,
      agents_required: s.agents_required,
      staff_to_schedule: s.staff_to_schedule,
      effective_agents: s.effective_agents,
      service_level_delivered: s.service_level_delivered,
      over_cap: s.over_cap,
      implausible: s.implausible,
      reason: s.reason,
      expected_talk_sec: talk,
      expected_talk: formatDuration(talk),
      abandon_share: s.abandon_share,
    }
  })
}

export interface RolledShift {
  name: ShiftName
  callsSum: number // unrounded sum over core hours
  rollup: ShiftRollup
  members: HourRow[] // core + boundary hours inside the range
}

export interface RolledDay {
  date: string
  shifts: RolledShift[] // Overnight, Day, Evening; only shifts with a core hour in the range
}

function maxOf(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null)
  return known.length ? Math.max(...known) : null
}

function minOf(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null)
  return known.length ? Math.min(...known) : null
}

// shift_memberships + rollup_shifts over the hours of the REQUESTED range. Core hours
// are counted once (calls); the boundary hour (Overnight 8, Day 16, Evening hour 0 of
// the next date) joins the staffing max/min of the shift it ends. A shift with no core
// hour in the range (the Evening before the first date) is dropped.
export function rollupShifts(hours: HourRow[]): RolledDay[] {
  const byKey = new Map<string, HourRow>()
  for (const h of hours) byKey.set(`${h.date}|${h.hour}`, h)
  const dates = [...new Set(hours.map((h) => h.date))].sort()

  const days: RolledDay[] = []
  for (const date of dates) {
    const shifts: RolledShift[] = []
    for (const spec of SHIFTS) {
      const core = spec.core
        .map((hour) => byKey.get(`${date}|${hour}`))
        .filter((h): h is HourRow => h !== undefined)
      if (!core.length) continue
      const boundaryDate = spec.boundary.nextDay ? addDays(date, 1) : date
      const boundary = byKey.get(`${boundaryDate}|${spec.boundary.hour}`)
      const members = boundary ? [...core, boundary] : core
      const callsSum = sum(core.map((h) => h.predicted_calls))
      const staffNeeded = maxOf(members.map((h) => h.staff_to_schedule))
      shifts.push({
        name: spec.name,
        callsSum,
        members,
        rollup: {
          predicted_calls: pyRound(callsSum, 2),
          agents_required: Math.max(...members.map((h) => h.agents_required)),
          staff_needed: staffNeeded,
          capped: staffNeeded === null ? null : staffNeeded > spec.cap,
          service_level_delivered: minOf(members.map((h) => h.service_level_delivered)),
          abandon_share: maxOf(members.map((h) => h.abandon_share)),
        },
      })
    }
    if (shifts.length) days.push({ date, shifts })
  }
  return days
}

function shiftsByName(day: RolledDay): Record<ShiftName, ShiftRollup | null> {
  const found = (name: ShiftName) => day.shifts.find((s) => s.name === name)?.rollup ?? null
  return { Overnight: found('Overnight'), Day: found('Day'), Evening: found('Evening') }
}

// The day's calls: the three UNROUNDED shift sums added, then rounded.
const dayCalls = (day: RolledDay) => pyRound(sum(day.shifts.map((s) => s.callsSum)), 2)

// _days_with_shifts: /api/staffing's days.
export function staffingDays(rolled: RolledDay[]): StaffingDay[] {
  return rolled.map((day) => ({
    date: day.date,
    predicted_calls: dayCalls(day),
    shifts: shiftsByName(day),
  }))
}

// _days_with_calendar: /api/forecast's days, with weekend, holiday and the day's talk
// time (all 24 hours of the date, as a sum of loads).
export function forecastDays(
  rolled: RolledDay[],
  hours: HourRow[],
  holidayNames: Map<string, string>
): ForecastDay[] {
  const loadByDate = new Map<string, number>()
  for (const h of hours) loadByDate.set(h.date, (loadByDate.get(h.date) ?? 0) + h.load_erlangs)
  return rolled.map((day) => {
    const talk = talkSeconds(loadByDate.get(day.date) ?? 0)
    return {
      date: day.date,
      is_weekend: isoWeekday(day.date) >= SATURDAY,
      holiday: holidayNames.get(day.date) ?? null,
      predicted_calls: dayCalls(day),
      expected_talk_sec: talk,
      expected_talk: formatDuration(talk),
      shifts: shiftsByName(day),
    }
  })
}

// _equal_weight_talk_sec: talk time over the window with EQUAL handle-time weighting,
// the reference of recency_effect_pct. Volume does not depend on recency, so the same
// predicted calls are multiplied by the equal-weight handle time of each cell.
export function equalWeightTalkSec(
  snapshot: Pick<ForecastSnapshot, 'cells'>,
  input: Pick<ForecastInput, 'recency'>,
  hours: HourRow[]
): number {
  if (input.recency === 'equal') return talkSeconds(sum(hours.map((h) => h.load_erlangs)))
  const equal = snapshot.cells.equal
  return sum(
    hours.map((h) => {
      const cell = equal[cellIndex(isoWeekday(h.date), h.hour)]
      if (!cell) throw new RangeError(`no equal-weight cell for ${h.date} ${h.hour}`)
      return h.predicted_calls * cell.ahtSec
    })
  )
}

// _abandoned_one_fewer: expected hang-ups if every hour scheduled ONE person fewer than
// recommended. None under Erlang C or at efficiency 0.
function abandonedOneFewer(
  hours: HourRow[],
  efficiency: number,
  targetSec: number,
  patienceSec: number | null
): number | null {
  if (patienceSec === null || efficiency === 0) return null
  if (hours.some((h) => h.staff_to_schedule === null)) return null
  let total = 0
  for (const h of hours) {
    const fewer = Math.max((h.staff_to_schedule as number) - 1, 0)
    const effective = Math.floor(fewer * efficiency)
    const share = abandonShare(effective, h.load_erlangs, h.aht_sec, targetSec, patienceSec)
    total += h.predicted_calls * (share as number)
  }
  return total
}

// _window_summary: totals over the requested window, with the caveat attached.
export function windowSummary(
  hours: HourRow[],
  input: Pick<ForecastInput, 'start' | 'end' | 'efficiency' | 'targetSec' | 'recency'>,
  patienceSec: number | null,
  equalTalkSec: number
): WindowSummary {
  const calls = sum(hours.map((h) => h.predicted_calls))
  const talk = talkSeconds(sum(hours.map((h) => h.load_erlangs)))
  const known = hours.filter((h) => h.abandon_share !== null)
  const abandoned = known.length
    ? sum(known.map((h) => h.predicted_calls * (h.abandon_share as number)))
    : null
  return {
    start: input.start,
    end: input.end,
    expected_calls: calls,
    expected_talk_sec: talk,
    expected_talk: formatDuration(talk),
    mean_aht_sec: calls > 0 ? talk / calls : null,
    expected_abandoned_calls: abandoned,
    abandon_share: abandoned !== null && calls > 0 ? abandoned / calls : null,
    expected_abandoned_one_fewer: abandonedOneFewer(
      hours,
      input.efficiency,
      input.targetSec,
      patienceSec
    ),
    recency: input.recency,
    recency_effect_pct: equalTalkSec > 0 ? (talk / equalTalkSec - 1) * 100 : 0,
    caveat: TALK_TIME_CAVEAT,
  }
}

// db/forecast.py holiday_coverage: does the holidays table reach the end of the window?
export function holidayCoverage(lastKnown: string, end: string): HolidayCoverage {
  const covered = end <= lastKnown
  return {
    last_known_holiday: lastKnown,
    covered,
    message: covered
      ? null
      : `Holiday calendar ends ${lastKnown}. Holidays after that date are not reflected ` +
        `in this forecast; load them into the holidays table.`,
  }
}

// api_planned after the forecast: the supervisor's roster against the recommendation,
// with what the PLANNED number delivers over the shift's core + boundary hours.
export function judgePlanned(
  hours: HourRow[],
  rolled: RolledDay[],
  input: Pick<PlannedInput, 'efficiency' | 'targetSec' | 'planned'>,
  patienceSec: number | null
): PlannedShiftResult[] {
  if (input.efficiency === 0) {
    throw apiError(
      400,
      'efficiency_zero',
      'efficiency is 0: people to schedule is undefined, so there is no roster to judge'
    )
  }
  const shifts = new Map<string, RolledShift>()
  for (const day of rolled) for (const s of day.shifts) shifts.set(`${day.date}|${s.name}`, s)

  return input.planned.map((item) => {
    const shift = shifts.get(`${item.date}|${item.shift}`)
    if (!shift || shift.rollup.staff_needed === null) {
      throw apiError(
        400,
        'outside_window',
        `${item.date} ${item.shift} is not inside the forecast window`
      )
    }
    const recommended = shift.rollup.staff_needed
    const cap = capForShift(item.shift)
    return {
      date: item.date,
      shift: item.shift,
      planned: item.planned,
      recommended,
      delta: item.planned - recommended,
      cap,
      verdict: verdict(item.planned, recommended, cap),
      ...plannedOutcome(shift.members, item.planned, input.efficiency, input.targetSec, patienceSec),
    }
  })
}
