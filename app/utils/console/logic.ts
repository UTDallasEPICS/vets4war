// Pure functions behind the staffing grid: web/logic.js of final-main in TypeScript,
// same names, same results. No DOM, no fetch. Everything the console displays is
// derived here from the cached forecast (predicted calls and handle time per hour) and
// the control values, so each number stays traceable and testable without a browser.
// The Erlang and staffing arithmetic underneath is the shared port (#shared/utils).
import type { ShiftName, Verdict } from '#shared/types/api'
import { SECONDS_PER_HOUR } from '#shared/utils/erlang'
import {
  EVENING_CAP,
  MAX_STAFF_PER_SHIFT,
  SHIFTS,
  SHIFT_NAMES,
  abandonShare,
  capForHour,
  capForShift,
  serviceLevel,
  shiftOfHour,
  staffForHour,
  verdict,
} from '#shared/utils/staffing'
import type { HourStaffing, ShiftSpec } from '#shared/utils/staffing'

export {
  EVENING_CAP,
  MAX_STAFF_PER_SHIFT,
  SECONDS_PER_HOUR,
  SHIFTS,
  SHIFT_NAMES,
  capForHour,
  capForShift,
  shiftOfHour,
  verdict,
}
export type { ShiftSpec }

export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => i)
export const VERDICTS: readonly Verdict[] = [
  'understaffed',
  'on target',
  'overstaffed',
  'exceeds capacity',
]
// Hours underlined on the time axis.
const PEAK_HOUR_COUNT = 4
export const STORAGE_KEY = 'v4w.planned.v1'

// The control values every recompute reads.
export interface Controls {
  efficiency: number
  targetPct: number
  targetSec: number
  patienceSec: number | null
}

// What the page keeps of each /api/forecast hour row.
export interface BaseHour {
  date: string
  hour: number
  predicted_calls: number
  predicted_real_calls: number
  aht_sec: number
}

export type CapState = 'under' | 'at' | 'over' | 'undef'

export interface ComputedHour extends HourStaffing {
  date: string
  hour: number
  predicted_real_calls: number
  cap: number
  cap_state: CapState
  service_level_if_capped: number | null
}

export const key = (date: string, hour: number) => `${date}:${hour}`
export const shiftKey = (date: string, shift: string) => `${date}|${shift}`

// Cap states. Three distinct situations with three distinct remedies:
// under = fine; at = no headroom; over = the roster cannot do this.
export function capState(
  staff: number | null | undefined,
  cap: number = MAX_STAFF_PER_SHIFT
): CapState {
  if (staff === null || staff === undefined) return 'undef'
  if (staff > cap) return 'over'
  if (staff === cap) return 'at'
  return 'under'
}

// Service level if an over-cap hour were clamped to its shift's cap: the consequence
// of "we only have 6 (or 7)". The recommendation is never clamped.
export function clampedServiceLevel(
  row: { load_erlangs: number; aht_sec: number },
  c: Controls,
  cap: number = MAX_STAFF_PER_SHIFT
): number {
  const effective = Math.floor(cap * c.efficiency)
  return serviceLevel(effective, row.load_erlangs, row.aht_sec, c.targetSec, c.patienceSec)
}

export interface Scale {
  lo: number
  hi: number
  steps: number
  levelOf: (staff: number) => number
}

// Discrete colour scale: one step per integer across the observed under-cap range.
// Four legible steps beat a gradient nobody can decode.
export function discreteScale(staffValues: (number | null)[]): Scale {
  const under = staffValues.filter((s): s is number => capState(s) === 'under')
  if (under.length === 0) return { lo: 0, hi: 0, steps: 1, levelOf: () => 0 }
  const lo = Math.min(...under)
  const hi = Math.max(...under)
  const steps = hi - lo + 1
  // 0..1 in equal integer steps
  const levelOf = (s: number) => (steps === 1 ? 1 : (s - lo) / (steps - 1))
  return { lo, hi, steps, levelOf }
}

// Staffing for every hour, from the cached forecast and the controls.
export function computeHours(baseHours: BaseHour[], c: Controls): ComputedHour[] {
  return baseHours.map((h) => {
    const cap = capForHour(h.hour)
    const r = staffForHour(
      h.predicted_calls,
      h.aht_sec,
      c.efficiency,
      c.targetPct,
      c.targetSec,
      c.patienceSec,
      cap
    )
    const state = capState(r.staff_to_schedule, cap)
    return {
      date: h.date,
      hour: h.hour,
      ...r,
      predicted_real_calls: h.predicted_real_calls,
      cap,
      cap_state: state,
      over_cap: r.staff_to_schedule === null ? r.over_cap : r.staff_to_schedule > cap,
      service_level_if_capped: state === 'over' ? clampedServiceLevel(r, c, cap) : null,
    }
  })
}

// How many cells changed their recommendation between two recomputes.
export function diffCells(
  prev: { staff_to_schedule: number | null }[] | null | undefined,
  next: { staff_to_schedule: number | null }[]
): number {
  if (!prev || prev.length !== next.length) return next.length
  let n = 0
  for (let i = 0; i < next.length; i++) {
    if (prev[i]!.staff_to_schedule !== next[i]!.staff_to_schedule) n++
  }
  return n
}

export interface RolledShift {
  predicted_calls: number
  agents_required: number
  staff_needed: number | null
  cap: number
  capped: boolean | null
  person_hours: number | null
  service_level_delivered: number | null
  abandon_share: number | null
  hours: ComputedHour[]
  core_hours: ComputedHour[]
}

export type RolledDay<D extends { date: string } = { date: string }> = D & {
  shifts: Record<ShiftName, RolledShift>
  person_hours: number | null
}

function shiftHours(
  byKey: Map<string, ComputedHour>,
  date: string,
  nextDate: string | undefined,
  spec: ShiftSpec
): { core: ComputedHour[]; all: ComputedHour[] } {
  const core = spec.core
    .map((h) => byKey.get(key(date, h)))
    .filter((r): r is ComputedHour => Boolean(r))
  const bKey = spec.boundary.nextDay
    ? nextDate
      ? key(nextDate, spec.boundary.hour)
      : null
    : key(date, spec.boundary.hour)
  const all = bKey && byKey.has(bKey) ? [...core, byKey.get(bKey)!] : core
  return { core, all }
}

// Shift roll-up. Mirrors db/staffing.rollup_shifts: staffing = max over core hours plus
// the overlap hour; calls and person-hours = core hours only.
export function rollupShifts<D extends { date: string }>(
  days: D[],
  hours: ComputedHour[]
): RolledDay<D>[] {
  const byKey = new Map(hours.map((h) => [key(h.date, h.hour), h]))
  const dates = days.map((d) => d.date)
  return days.map((day, i) => {
    const shifts = {} as Record<ShiftName, RolledShift>
    SHIFTS.forEach((spec) => {
      const { core, all } = shiftHours(byKey, day.date, dates[i + 1], spec)
      const staff = all.map((r) => r.staff_to_schedule)
      const undefined_ = staff.some((s) => s === null) || all.length === 0
      const peak = undefined_ ? null : Math.max(...(staff as number[]))
      shifts[spec.name] = {
        predicted_calls: core.reduce((a, r) => a + r.predicted_calls, 0),
        agents_required: all.length ? Math.max(...all.map((r) => r.agents_required)) : 0,
        staff_needed: peak,
        cap: spec.cap,
        capped: peak === null ? null : peak > spec.cap,
        person_hours: undefined_
          ? null
          : core.reduce((a, r) => a + (r.staff_to_schedule as number), 0),
        service_level_delivered: undefined_
          ? null
          : Math.min(...all.map((r) => r.service_level_delivered as number)),
        abandon_share:
          undefined_ || all.some((r) => r.abandon_share === null)
            ? null
            : Math.max(...all.map((r) => r.abandon_share as number)),
        hours: all,
        core_hours: core,
      }
    })
    const totals = Object.values(shifts).map((s) => s.person_hours)
    return {
      ...day,
      shifts,
      person_hours: totals.some((t) => t === null)
        ? null
        : (totals as number[]).reduce((a, b) => a + b, 0),
    }
  })
}

export interface PlannedOutcome {
  effective_agents: number | null
  service_level: number | null
  abandon_share: number | null
}

// What `planned` people deliver for every hour of a shift: the same chain as
// staffForHour evaluated at the supervisor's number. Worst hour reported. Unlike the
// shared plannedOutcome (API field names, throws), the console gets nulls at
// efficiency 0 or for a shift with no hours.
export function plannedOutcome(
  rows: { load_erlangs: number; aht_sec: number }[],
  planned: number,
  c: Controls
): PlannedOutcome {
  if (c.efficiency === 0 || rows.length === 0) {
    return { effective_agents: null, service_level: null, abandon_share: null }
  }
  const effective = Math.floor(planned * c.efficiency)
  const levels = rows.map((r) =>
    serviceLevel(effective, r.load_erlangs, r.aht_sec, c.targetSec, c.patienceSec)
  )
  const abandons = rows.map((r) =>
    abandonShare(effective, r.load_erlangs, r.aht_sec, c.targetSec, c.patienceSec)
  )
  const known = abandons.filter((a): a is number => a !== null)
  return {
    effective_agents: effective,
    service_level: Math.min(...levels),
    abandon_share: known.length ? Math.max(...known) : null,
  }
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface PlannedStore {
  get(date: string, shift: string): number | null
  set(date: string, shift: string, value: number | null | undefined): void
  clear(): void
  size(): number
}

// Persistence for planned values. Only the supervisor's own entries are stored (never
// our defaults), so untouched shifts keep following the recommendation when controls
// change. Every storage call is guarded: a private window or a blocked origin must not
// break the page.
export function createPlannedStore(storage: StorageLike | null | undefined): PlannedStore {
  function read(): Record<string, unknown> {
    try {
      const raw = storage && storage.getItem(STORAGE_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  function write(data: Record<string, unknown>) {
    try {
      if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // storage unavailable: in-memory only
    }
  }
  let memory = read()
  return {
    get(date, shift) {
      const v = memory[shiftKey(date, shift)]
      return Number.isInteger(v) ? (v as number) : null
    },
    set(date, shift, value) {
      const k = shiftKey(date, shift)
      const next =
        value === null || value === undefined
          ? Object.fromEntries(Object.entries(memory).filter(([name]) => name !== k))
          : { ...memory, [k]: value }
      memory = next
      write(next)
    },
    clear() {
      memory = {}
      write({})
    },
    size() {
      return Object.keys(memory).length
    },
  }
}

export interface ShiftTotals {
  staff: number
  effective: number
  calls: number
  lost: number
  inTime: number
  late: number
  lostShare: number | null
  serviceLevel: number | null
}

// What `staff` people deliver over a shift's CORE hours (each call counted once), in
// calls, not just shares. Per hour: floor(staff x efficiency) on inbound, Erlang A.
// serviceLevel = share of ALL calls answered within the target; late = answered, but
// after the target; lost = hung up.
export function shiftTotals(
  coreHours: { predicted_calls: number; load_erlangs: number; aht_sec: number }[] | null,
  staff: number | null,
  c: Controls
): ShiftTotals | null {
  if (
    c.patienceSec === null ||
    c.efficiency === 0 ||
    !coreHours ||
    coreHours.length === 0 ||
    staff === null
  ) {
    return null
  }
  const patience = c.patienceSec
  const effective = Math.floor(staff * c.efficiency)
  let calls = 0
  let lost = 0
  let inTime = 0
  coreHours.forEach((h) => {
    calls += h.predicted_calls
    lost +=
      h.predicted_calls *
      (abandonShare(effective, h.load_erlangs, h.aht_sec, c.targetSec, patience) as number)
    inTime +=
      h.predicted_calls * serviceLevel(effective, h.load_erlangs, h.aht_sec, c.targetSec, patience)
  })
  const late = Math.max(0, calls - lost - inTime)
  return {
    staff,
    effective,
    calls,
    lost,
    inTime,
    late,
    lostShare: calls > 0 ? lost / calls : null,
    serviceLevel: calls > 0 ? inTime / calls : null,
  }
}

// One shiftTotals row per staff number from `minStaff` to the shift cap: the "what
// does 4 vs 5 vs 6 cost" table.
const TRADEOFF_MIN_STAFF = 1
export function shiftTradeoff(
  coreHours: { predicted_calls: number; load_erlangs: number; aht_sec: number }[],
  cap: number,
  c: Controls,
  minStaff: number = TRADEOFF_MIN_STAFF
): ShiftTotals[] {
  const rows: ShiftTotals[] = []
  for (let n = minStaff; n <= cap; n++) {
    const t = shiftTotals(coreHours, n, c)
    if (t === null) return []
    rows.push(t)
  }
  return rows
}

export interface PlannedShift {
  planned: number | null
  recommended: number | null
  delta: number | null
  verdict: Verdict | null
  is_own: boolean
  effective_agents: number | null
  service_level: number | null
  abandon_share: number | null
  // Present when there is a verdict.
  totals?: ShiftTotals | null
  recommendedTotals?: ShiftTotals | null
}

export type JudgedDay<D extends { date: string } = { date: string }> = RolledDay<D> & {
  planned: Record<ShiftName, PlannedShift>
}

// Planned value + verdict + consequence for every shift of every day.
export function judgeRoster<D extends { date: string }>(
  rolled: RolledDay<D>[],
  store: Pick<PlannedStore, 'get'>,
  c: Controls
): JudgedDay<D>[] {
  return rolled.map((day) => {
    const judged = {} as Record<ShiftName, PlannedShift>
    SHIFT_NAMES.forEach((name) => {
      const s = day.shifts[name]
      const rec = s.staff_needed
      const own = store.get(day.date, name)
      const planned = own !== null ? own : rec
      judged[name] =
        rec === null || planned === null
          ? {
              planned,
              recommended: rec,
              delta: null,
              verdict: null,
              is_own: own !== null,
              service_level: null,
              abandon_share: null,
              effective_agents: null,
            }
          : {
              planned,
              recommended: rec,
              delta: planned - rec,
              verdict: verdict(planned, rec, capForShift(name)),
              is_own: own !== null,
              ...plannedOutcome(s.hours, planned, c),
              totals: shiftTotals(s.core_hours, planned, c),
              recommendedTotals: shiftTotals(s.core_hours, rec, c),
            }
    })
    return { ...day, planned: judged }
  })
}

export interface Summary {
  n: number
  calls: number
  realCalls: number
  talkSec: number
  meanAht: number | null
  personHours: number | null
  peakStaff: number | null
  abandoned: number | null
}

type SummaryHour = Pick<
  ComputedHour,
  | 'predicted_calls'
  | 'predicted_real_calls'
  | 'load_erlangs'
  | 'staff_to_schedule'
  | 'abandon_share'
>

// Summaries: whole window, a drag selection, or one day.
export function summarize(hours: SummaryHour[]): Summary {
  const calls = hours.reduce((a, h) => a + h.predicted_calls, 0)
  const realCalls = hours.reduce((a, h) => a + h.predicted_real_calls, 0)
  const talkSec = hours.reduce((a, h) => a + h.load_erlangs * SECONDS_PER_HOUR, 0)
  const staffed = hours.map((h) => h.staff_to_schedule)
  const personHours = staffed.some((s) => s === null)
    ? null
    : (staffed as number[]).reduce((a, s) => a + s, 0)
  const peakStaff =
    staffed.some((s) => s === null) || !staffed.length ? null : Math.max(...(staffed as number[]))
  const known = hours.filter((h) => h.abandon_share !== null)
  const abandoned = known.length
    ? known.reduce((a, h) => a + h.predicted_calls * (h.abandon_share as number), 0)
    : null
  return {
    n: hours.length,
    calls,
    realCalls,
    talkSec,
    meanAht: calls > 0 ? talkSec / calls : null,
    personHours,
    peakStaff,
    abandoned,
  }
}

// Expected abandoned calls if every hour scheduled ONE FEWER person. Mirrors
// api.main._abandoned_one_fewer. This is what the slack buys.
export function abandonedOneFewer(hours: ComputedHour[], c: Controls): number | null {
  if (
    c.patienceSec === null ||
    c.efficiency === 0 ||
    hours.some((h) => h.staff_to_schedule === null)
  ) {
    return null
  }
  const patience = c.patienceSec
  return hours.reduce((a, h) => {
    const effective = Math.floor(Math.max((h.staff_to_schedule as number) - 1, 0) * c.efficiency)
    return (
      a +
      h.predicted_calls *
        (abandonShare(effective, h.load_erlangs, h.aht_sec, c.targetSec, patience) as number)
    )
  }, 0)
}

export type Roster = Record<ShiftName, number>

export interface RosterResult {
  calls: number
  abandoned: number
  abandonShare: number | null
  serviceLevel: number | null
}

// What a FIXED roster delivers over the window: every hour gets the roster number of
// the shift whose core hours contain it (the partner's real 4/4/6 by default). Same
// chain as everything else: floor(staff x efficiency) on inbound, Erlang A for
// hang-ups and answered-in-time.
export function rosterOutcome(
  hours: { hour: number; predicted_calls: number; load_erlangs: number; aht_sec: number }[],
  roster: Roster,
  c: Controls
): RosterResult | null {
  if (c.patienceSec === null || c.efficiency === 0 || hours.length === 0) return null
  const patience = c.patienceSec
  let calls = 0
  let abandoned = 0
  let answered = 0
  hours.forEach((h) => {
    const shift = shiftOfHour(h.hour)
    const effective = Math.floor(roster[shift] * c.efficiency)
    calls += h.predicted_calls
    abandoned +=
      h.predicted_calls *
      (abandonShare(effective, h.load_erlangs, h.aht_sec, c.targetSec, patience) as number)
    answered +=
      h.predicted_calls * serviceLevel(effective, h.load_erlangs, h.aht_sec, c.targetSec, patience)
  })
  return {
    calls,
    abandoned,
    abandonShare: calls > 0 ? abandoned / calls : null,
    serviceLevel: calls > 0 ? answered / calls : null,
  }
}

export interface DayStats extends Summary {
  peakHour: number | null
  atCap: number[]
  overCap: number[]
  shifts: Record<ShiftName, RolledShift>
  planned: Record<ShiftName, PlannedShift>
}

export function dayStats(
  day: { shifts: Record<ShiftName, RolledShift>; planned: Record<ShiftName, PlannedShift> },
  dayHours: ComputedHour[]
): DayStats {
  const s = summarize(dayHours)
  const peakHour = dayHours.length
    ? dayHours.reduce((a, b) => (b.predicted_calls > a.predicted_calls ? b : a))
    : null
  return {
    ...s,
    peakHour: peakHour ? peakHour.hour : null,
    atCap: dayHours.filter((h) => h.cap_state === 'at').map((h) => h.hour),
    overCap: dayHours.filter((h) => h.cap_state === 'over').map((h) => h.hour),
    shifts: day.shifts,
    planned: day.planned,
  }
}

// Hours of the day that carry the most calls across the loaded window.
export function peakHours(
  hours: { hour: number; predicted_calls: number }[],
  count: number = PEAK_HOUR_COUNT
): number[] {
  const sum = new Array<number>(24).fill(0)
  const n = new Array<number>(24).fill(0)
  hours.forEach((h) => {
    sum[h.hour]! += h.predicted_calls
    n[h.hour]! += 1
  })
  return HOURS.filter((h) => n[h]! > 0)
    .map((h): [number, number] => [h, sum[h]! / n[h]!])
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([h]) => h)
}

// CSV export: the full hourly table plus the shift's planned value and verdict on
// every hour of that shift. Values are unrounded.
export const CSV_COLUMNS = [
  'date',
  'hour',
  'shift',
  'predicted_calls',
  'aht_sec',
  'load_erlangs',
  'agents_required',
  'staff_to_schedule',
  'effective_agents',
  'service_level_delivered',
  'abandon_share',
  'cap_state',
  'service_level_if_capped',
  'planned_shift_staff',
  'verdict',
  'service_level_at_planned',
] as const

export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string | number | null>

export function csvRows(
  hours: ComputedHour[],
  judgedDays: { date: string; planned?: Record<ShiftName, PlannedShift> }[]
): CsvRow[] {
  const byDate = new Map(judgedDays.map((d) => [d.date, d]))
  return hours.map((h) => {
    const name = shiftOfHour(h.hour)
    const day = byDate.get(h.date)
    const p = day && day.planned ? day.planned[name] : null
    return {
      date: h.date,
      hour: h.hour,
      shift: name,
      predicted_calls: h.predicted_calls,
      aht_sec: h.aht_sec,
      load_erlangs: h.load_erlangs,
      agents_required: h.agents_required,
      staff_to_schedule: h.staff_to_schedule,
      effective_agents: h.effective_agents,
      service_level_delivered: h.service_level_delivered,
      abandon_share: h.abandon_share,
      cap_state: h.cap_state,
      service_level_if_capped: h.service_level_if_capped,
      planned_shift_staff: p ? p.planned : null,
      verdict: p ? p.verdict : null,
      service_level_at_planned: p ? p.service_level : null,
    }
  })
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(
  rows: Record<string, unknown>[],
  columns: readonly string[] = CSV_COLUMNS
): string {
  const lines = [columns.join(',')]
  rows.forEach((r) => lines.push(columns.map((c) => csvCell(r[c])).join(',')))
  return lines.join('\n') + '\n'
}
