// Input of the forecast routes (PLAN.md section 8.2): the query of GET /api/forecast and
// /api/staffing, the JSON body of POST /api/planned. Ranges and defaults are final-main's
// FastAPI declarations (api/main.py). Every field problem is collected and thrown as ONE
// 422; then the two range refusals, in final-main's order.
import { addDays, daysBetween, isIsoDate } from '#shared/utils/dates'
import { MAX_PLANNED, MAX_RANGE_DAYS, DEFAULT_HORIZON_DAYS } from '#shared/utils/constants'
import {
  DEFAULT_EFFICIENCY,
  DEFAULT_QUEUE_MODEL,
  DEFAULT_RECENCY,
  DEFAULT_TARGET_PCT,
  DEFAULT_TARGET_SEC,
  QUEUE_MODELS,
  RECENCY_OPTIONS,
  SHIFT_NAMES,
} from '#shared/utils/staffing'
import type { PlannedItem, QueueModel, Recency, ShiftName } from '#shared/types/api'
import { apiError, validationError, type Issue } from '../http'

export interface ForecastInput {
  start: string
  end: string
  efficiency: number
  targetPct: number
  targetSec: number
  queueModel: QueueModel
  patienceSec: number | null
  recency: Recency
  includeHolidays: boolean
}

export type PlannedInput = ForecastInput & { planned: PlannedItem[] }

// At most one item per shift of the longest window.
export const MAX_PLANNED_ITEMS = MAX_RANGE_DAYS * SHIFT_NAMES.length

interface Bounds {
  min: number
  max: number
  minOpen?: boolean // min itself is not allowed
  maxOpen?: boolean
}

const EFFICIENCY: Bounds = { min: 0, max: 1 }
// Tighter than final-main's (0 < target_pct < 1, target_sec <= 3600, 0 < patience_sec
// <= 86400), because the Erlang A chain runs on the server's one thread. Outside these
// bounds one request cost up to 31 s of CPU per day of range (patience 20 s, answer
// within 3600 s): the uniformization behind the service level needs (target_sec /
// patience_sec) x queue length steps, and exp() underflows to 0 once that passes ~745,
// after which every hour runs to the 100,000-step cap. Inside them the worst case
// measured is about 37 ms per day (see compute cost tests and the WP2 report).
// target_pct stops at 0.999 because the TypeScript Erlang A service level saturates
// at 1 - 2.2e-16, so a target closer to 1 could never be met.
export const ACCEPTED_TARGET_PCT_MAX = 0.999
export const ACCEPTED_TARGET_SEC_MAX = 300
export const ACCEPTED_PATIENCE_SEC_MIN = 10
export const ACCEPTED_PATIENCE_SEC_MAX = 3600

const TARGET_PCT: Bounds = { min: 0, max: ACCEPTED_TARGET_PCT_MAX, minOpen: true }
const TARGET_SEC: Bounds = { min: 0, max: ACCEPTED_TARGET_SEC_MAX }
const PATIENCE_SEC: Bounds = { min: ACCEPTED_PATIENCE_SEC_MIN, max: ACCEPTED_PATIENCE_SEC_MAX }
const PLANNED: Bounds = { min: 0, max: MAX_PLANNED }

// A plain decimal number as a query string carries it: no hex, no 'Infinity', no blanks.
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function describe(b: Bounds): string {
  return `must be a number ${b.minOpen ? 'greater than' : 'from'} ${b.min} ${
    b.maxOpen ? 'and less than' : b.minOpen ? 'and at most' : 'to'
  } ${b.max}`
}

function inBounds(n: number, b: Bounds): boolean {
  if (!Number.isFinite(n)) return false
  if (b.minOpen ? n <= b.min : n < b.min) return false
  if (b.maxOpen ? n >= b.max : n > b.max) return false
  return true
}

class Collector {
  readonly issues: Issue[] = []
  add(path: string, message: string) {
    this.issues.push({ path, message })
  }
}

// --- query (strings) --------------------------------------------------------------------

// A repeated query parameter: the last value counts, as in Starlette.
function single(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value
}

function queryNumber(c: Collector, query: Record<string, unknown>, name: string, b: Bounds) {
  const raw = single(query[name])
  if (raw === undefined) return undefined
  const n = typeof raw === 'string' && DECIMAL.test(raw) ? Number(raw) : Number.NaN
  if (!inBounds(n, b)) {
    c.add(name, describe(b))
    return undefined
  }
  return n
}

function queryDate(c: Collector, query: Record<string, unknown>, name: string) {
  const raw = single(query[name])
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !isIsoDate(raw)) {
    c.add(name, 'must be a real calendar date in the form YYYY-MM-DD')
    return undefined
  }
  return raw
}

function queryChoice<T extends string>(
  c: Collector,
  query: Record<string, unknown>,
  name: string,
  choices: readonly T[]
): T | undefined {
  const raw = single(query[name])
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !(choices as readonly string[]).includes(raw)) {
    c.add(name, `must be one of ${choices.join(', ')}`)
    return undefined
  }
  return raw as T
}

function queryBoolean(c: Collector, query: Record<string, unknown>, name: string) {
  const raw = single(query[name])
  if (raw === undefined) return undefined
  const text = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (text === 'true' || text === '1') return true
  if (text === 'false' || text === '0') return false
  c.add(name, 'must be true or false')
  return undefined
}

// --- body (JSON values) -----------------------------------------------------------------

function bodyNumber(c: Collector, value: unknown, path: string, b: Bounds, integer = false) {
  if (typeof value !== 'number' || !inBounds(value, b) || (integer && !Number.isInteger(value))) {
    c.add(path, integer ? `must be an integer from ${b.min} to ${b.max}` : describe(b))
    return undefined
  }
  return value
}

function bodyDate(c: Collector, value: unknown, path: string) {
  if (typeof value !== 'string' || !isIsoDate(value)) {
    c.add(path, 'must be a real calendar date in the form YYYY-MM-DD')
    return undefined
  }
  return value
}

function bodyChoice<T extends string>(
  c: Collector,
  value: unknown,
  path: string,
  choices: readonly T[]
): T | undefined {
  if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) {
    c.add(path, `must be one of ${choices.join(', ')}`)
    return undefined
  }
  return value as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// --- the two range refusals -------------------------------------------------------------

function checkRange(start: string, end: string) {
  if (end < start) {
    throw apiError(400, 'end_before_start', `end ${end} is before start ${start}`)
  }
  const span = daysBetween(start, end) + 1
  if (span > MAX_RANGE_DAYS) {
    throw apiError(
      400,
      'range_too_long',
      `range is ${span} days; maximum is ${MAX_RANGE_DAYS}`
    )
  }
}

// GET /api/forecast and /api/staffing. `today` is the line's date (America/New_York).
// As in final-main, a missing end is today + 29 days whatever the start.
export function parseForecastQuery(query: Record<string, unknown>, today: string): ForecastInput {
  const c = new Collector()
  const start = queryDate(c, query, 'start')
  const end = queryDate(c, query, 'end')
  const efficiency = queryNumber(c, query, 'efficiency', EFFICIENCY)
  const targetPct = queryNumber(c, query, 'target_pct', TARGET_PCT)
  const targetSec = queryNumber(c, query, 'target_sec', TARGET_SEC)
  const queueModel = queryChoice(c, query, 'queue_model', QUEUE_MODELS)
  const patienceSec = queryNumber(c, query, 'patience_sec', PATIENCE_SEC)
  const recency = queryChoice(c, query, 'recency', RECENCY_OPTIONS)
  const includeHolidays = queryBoolean(c, query, 'include_holidays')
  if (c.issues.length) throw validationError(c.issues)

  const input: ForecastInput = {
    start: start ?? today,
    end: end ?? addDays(today, DEFAULT_HORIZON_DAYS - 1),
    efficiency: efficiency ?? DEFAULT_EFFICIENCY,
    targetPct: targetPct ?? DEFAULT_TARGET_PCT,
    targetSec: targetSec ?? DEFAULT_TARGET_SEC,
    queueModel: queueModel ?? DEFAULT_QUEUE_MODEL,
    patienceSec: patienceSec ?? null,
    recency: recency ?? DEFAULT_RECENCY,
    includeHolidays: includeHolidays ?? true,
  }
  checkRange(input.start, input.end)
  return input
}

// POST /api/planned. start and end are required here; the other controls default as in
// the query.
export function parsePlannedBody(body: unknown): PlannedInput {
  const c = new Collector()
  if (!isRecord(body)) {
    c.add('', 'the body must be a JSON object')
    throw validationError(c.issues)
  }
  const requiredDate = (name: string): string | undefined => {
    if (body[name] !== undefined) return bodyDate(c, body[name], name)
    c.add(name, 'is required')
    return undefined
  }
  const start = requiredDate('start')
  const end = requiredDate('end')
  const optional = <T>(name: string, read: (value: unknown) => T | undefined): T | undefined =>
    body[name] === undefined ? undefined : read(body[name])
  const efficiency = optional('efficiency', (v) => bodyNumber(c, v, 'efficiency', EFFICIENCY))
  const targetPct = optional('target_pct', (v) => bodyNumber(c, v, 'target_pct', TARGET_PCT))
  const targetSec = optional('target_sec', (v) => bodyNumber(c, v, 'target_sec', TARGET_SEC))
  const queueModel = optional('queue_model', (v) => bodyChoice(c, v, 'queue_model', QUEUE_MODELS))
  const patienceSec =
    body.patience_sec === null
      ? undefined
      : optional('patience_sec', (v) => bodyNumber(c, v, 'patience_sec', PATIENCE_SEC))
  const recency = optional('recency', (v) => bodyChoice(c, v, 'recency', RECENCY_OPTIONS))
  const includeHolidays = optional('include_holidays', (v) => {
    if (typeof v === 'boolean') return v
    c.add('include_holidays', 'must be true or false')
    return undefined
  })

  const planned: PlannedItem[] = []
  if (!Array.isArray(body.planned)) {
    c.add('planned', body.planned === undefined ? 'is required' : 'must be a list')
  } else if (body.planned.length > MAX_PLANNED_ITEMS) {
    c.add('planned', `must have at most ${MAX_PLANNED_ITEMS} items`)
  } else {
    body.planned.forEach((item: unknown, i: number) => {
      const path = `planned.${i}`
      if (!isRecord(item)) {
        c.add(path, 'must be an object with date, shift and planned')
        return
      }
      const date = bodyDate(c, item.date, `${path}.date`)
      const shift = bodyChoice<ShiftName>(c, item.shift, `${path}.shift`, SHIFT_NAMES)
      const count = bodyNumber(c, item.planned, `${path}.planned`, PLANNED, true)
      if (date !== undefined && shift !== undefined && count !== undefined) {
        planned.push({ date, shift, planned: count })
      }
    })
  }
  if (c.issues.length || start === undefined || end === undefined) {
    throw validationError(c.issues)
  }

  checkRange(start, end)
  return {
    start,
    end,
    efficiency: efficiency ?? DEFAULT_EFFICIENCY,
    targetPct: targetPct ?? DEFAULT_TARGET_PCT,
    targetSec: targetSec ?? DEFAULT_TARGET_SEC,
    queueModel: queueModel ?? DEFAULT_QUEUE_MODEL,
    patienceSec: patienceSec ?? null,
    recency: recency ?? DEFAULT_RECENCY,
    includeHolidays: includeHolidays ?? true,
    planned,
  }
}
