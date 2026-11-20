// Hourly staffing from the forecast: the pure part of final-main's db/staffing.py
// (through web/erlang.js and web/logic.js). Field names follow the /api/forecast hour
// row. tests/parity/staffing pins staffForHour, plannedOutcome and the Erlang functions
// to the Python.
//
// Shift staffing is the MAX of the hourly requirement inside the shift, not the mean:
// you staff for the peak or you miss the target at the peak. Caps are flagged, never
// clamped. At efficiency 0 nobody scheduled is ever on inbound, so people-to-schedule
// is undefined (null, with a reason); above MAX_PLAUSIBLE_STAFF the number is returned
// but flagged implausible.
import type { QueueModel, ShiftName, Verdict } from '../types/api'
import { erlangA, erlangC, requiredAgents, SECONDS_PER_HOUR } from './erlang'

// The partner's own staff-efficiency calculator: 480-minute shift minus 45 breaks,
// 60 outbound, 60 training/admin = 315 / 480.
export const DEFAULT_EFFICIENCY = 0.65625
export const DEFAULT_TARGET_PCT = 0.8
export const DEFAULT_TARGET_SEC = 30
export const DEFAULT_QUEUE_MODEL = 'erlang_a'
export const DEFAULT_RECENCY = 'weighted'
export const QUEUE_MODELS = ['erlang_a', 'erlang_c'] as const
export const RECENCY_OPTIONS = ['equal', 'weighted', 'recent'] as const
export const MAX_STAFF_PER_SHIFT = 7
// Partner rule (2026-10-21 meeting): never more than 6 from 16:00 to midnight.
export const EVENING_CAP = 6
// Above this many people in one hour the efficiency input, not the phones, needs fixing.
export const MAX_PLAUSIBLE_STAFF = 50

export const ZERO_EFFICIENCY_REASON =
  'efficiency is 0: no scheduled person is ever free for inbound calls, ' +
  'so people to schedule is undefined'

// The partner's three tours. `core` hours are counted once (calls); the `boundary`
// hour is the 30-minute overlap at the tour's end and joins the staffing peak of both
// adjacent tours. Evening's boundary is hour 0 of the NEXT date.
export interface ShiftSpec {
  name: ShiftName
  short: 'O' | 'D' | 'E'
  span: string
  core: number[]
  boundary: { hour: number; nextDay: boolean }
  cap: number
}

const hours = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

export const SHIFTS: readonly ShiftSpec[] = [
  {
    name: 'Overnight',
    short: 'O',
    span: '00:00 to 08:30',
    core: hours(0, 8),
    boundary: { hour: 8, nextDay: false },
    cap: MAX_STAFF_PER_SHIFT,
  },
  {
    name: 'Day',
    short: 'D',
    span: '08:00 to 16:30',
    core: hours(8, 16),
    boundary: { hour: 16, nextDay: false },
    cap: MAX_STAFF_PER_SHIFT,
  },
  {
    name: 'Evening',
    short: 'E',
    span: '16:00 to 00:30',
    core: hours(16, 24),
    boundary: { hour: 0, nextDay: true },
    cap: EVENING_CAP,
  },
]

export const SHIFT_NAMES: readonly ShiftName[] = SHIFTS.map((s) => s.name)

function shiftContaining(hour: number): ShiftSpec {
  const spec = SHIFTS.find((s) => s.core.includes(hour))
  if (!spec) throw new RangeError(`hour must be 0..23, got ${hour}`)
  return spec
}

// Cap of the shift whose CORE hours contain `hour` (the overlap hour belongs to the
// shift it starts).
export function capForHour(hour: number): number {
  return shiftContaining(hour).cap
}

export function capForShift(name: ShiftName): number {
  const spec = SHIFTS.find((s) => s.name === name)
  if (!spec)
    throw new RangeError(`unknown shift ${name}; expected one of ${SHIFT_NAMES.join(', ')}`)
  return spec.cap
}

export function shiftOfHour(hour: number): ShiftName {
  return shiftContaining(hour).name
}

// Share of all arriving calls answered within targetSec with `agents` on inbound.
// Erlang C when patienceSec is null, else Erlang A.
export function serviceLevel(
  agents: number,
  load: number,
  ahtSec: number,
  targetSec: number,
  patienceSec: number | null = null
): number {
  if (agents <= 0) return 0.0
  if (patienceSec !== null) {
    return erlangA(agents, load, ahtSec, patienceSec, targetSec).service_level
  }
  return 1.0 - erlangC(agents, load) * Math.exp((-(agents - load) * targetSec) / ahtSec)
}

// Share of arriving callers who hang up before an answer; null under Erlang C, which
// assumes nobody hangs up.
export function abandonShare(
  agents: number,
  load: number,
  ahtSec: number,
  targetSec: number,
  patienceSec: number | null
): number | null {
  if (patienceSec === null) return null
  if (agents <= 0) return load > 0 ? 1.0 : 0.0
  return erlangA(agents, load, ahtSec, patienceSec, targetSec).abandon_prob
}

// People to schedule so that at least agentsRequired are on inbound after efficiency
// loss, and how many of them are: ceil(agents / efficiency), floor(scheduled * efficiency).
export function schedulePeople(
  agentsRequired: number,
  efficiency: number
): [number | null, number | null] {
  if (!(efficiency >= 0 && efficiency <= 1)) {
    throw new RangeError(`efficiency must be in [0, 1], got ${efficiency}`)
  }
  if (efficiency === 0) return [null, null]
  const scheduled = Math.ceil(agentsRequired / efficiency)
  return [scheduled, Math.floor(scheduled * efficiency)]
}

function implausibleReason(scheduled: number): string | null {
  if (scheduled <= MAX_PLAUSIBLE_STAFF) return null
  return (
    `${scheduled} people in one hour exceeds the plausible bound of ` +
    `${MAX_PLAUSIBLE_STAFF} for this line; the efficiency input is not actionable`
  )
}

export interface HourStaffing {
  predicted_calls: number
  aht_sec: number
  load_erlangs: number
  agents_required: number
  staff_to_schedule: number | null
  effective_agents: number | null
  service_level_delivered: number | null
  over_cap: boolean | null
  implausible: boolean
  reason: string | null
  abandon_share: number | null
  queue_model: QueueModel
  patience_sec: number | null
}

// db/staffing.py: staff_for_hour, with the API's hour-row field names.
// patienceSec null = Erlang C. over_cap = scheduled > cap.
export function staffForHour(
  predictedCalls: number,
  ahtSec: number,
  efficiency: number,
  targetPct: number,
  targetSec: number,
  patienceSec: number | null = null,
  cap: number = MAX_STAFF_PER_SHIFT
): HourStaffing {
  if (!(efficiency >= 0 && efficiency <= 1)) {
    throw new RangeError(`efficiency must be in [0, 1], got ${efficiency}`)
  }
  if (predictedCalls < 0) {
    throw new RangeError(`predicted_offered must be >= 0, got ${predictedCalls}`)
  }
  const load = (predictedCalls * ahtSec) / SECONDS_PER_HOUR
  const agents = requiredAgents(predictedCalls, ahtSec, targetPct, targetSec, patienceSec)
  const [scheduled, effective] = schedulePeople(agents, efficiency)
  const queueModel: QueueModel = patienceSec === null ? 'erlang_c' : 'erlang_a'
  if (scheduled === null || effective === null) {
    return {
      predicted_calls: predictedCalls,
      aht_sec: ahtSec,
      load_erlangs: load,
      agents_required: agents,
      staff_to_schedule: null,
      effective_agents: null,
      service_level_delivered: null,
      over_cap: null,
      implausible: false,
      reason: ZERO_EFFICIENCY_REASON,
      abandon_share: null,
      queue_model: queueModel,
      patience_sec: patienceSec,
    }
  }
  const reason = implausibleReason(scheduled)
  return {
    predicted_calls: predictedCalls,
    aht_sec: ahtSec,
    load_erlangs: load,
    agents_required: agents,
    staff_to_schedule: scheduled,
    effective_agents: effective,
    service_level_delivered: serviceLevel(effective, load, ahtSec, targetSec, patienceSec),
    over_cap: scheduled > cap,
    implausible: reason !== null,
    reason,
    abandon_share: abandonShare(effective, load, ahtSec, targetSec, patienceSec),
    queue_model: queueModel,
    patience_sec: patienceSec,
  }
}

// The partner's question: over or under staffed? Capacity wins over every other
// reading because it is the one the roster cannot do. `cap` is the shift's cap.
export function verdict(
  planned: number,
  recommended: number,
  cap: number = MAX_STAFF_PER_SHIFT
): Verdict {
  if (planned > cap) return 'exceeds capacity'
  if (planned < recommended) return 'understaffed'
  if (planned > recommended) return 'overstaffed'
  return 'on target'
}

// db/staffing.py: planned_outcome. Schedule `planned` people for every hour of a shift
// and report the worst hour: effective agents = floor(planned * efficiency), lowest
// service level, highest abandonment.
export function plannedOutcome(
  rows: { load_erlangs: number; aht_sec: number }[],
  planned: number,
  efficiency: number,
  targetSec: number,
  patienceSec: number | null
): {
  effective_agents: number
  service_level_at_planned: number
  abandon_share_at_planned: number | null
} {
  if (planned < 0) throw new RangeError(`planned must be >= 0, got ${planned}`)
  if (!(efficiency >= 0 && efficiency <= 1)) {
    throw new RangeError(`efficiency must be in [0, 1], got ${efficiency}`)
  }
  if (rows.length === 0) throw new RangeError('shift has no hours in the forecast window')
  const effective = Math.floor(planned * efficiency)
  const levels = rows.map((r) =>
    serviceLevel(effective, r.load_erlangs, r.aht_sec, targetSec, patienceSec)
  )
  const abandons = rows.map((r) =>
    abandonShare(effective, r.load_erlangs, r.aht_sec, targetSec, patienceSec)
  )
  const known = abandons.filter((a): a is number => a !== null)
  return {
    effective_agents: effective,
    service_level_at_planned: Math.min(...levels),
    abandon_share_at_planned: known.length ? Math.max(...known) : null,
  }
}
