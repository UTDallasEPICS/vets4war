// What one calendar day of calls looks like, and how a day of a file compares with the
// same day in `calls` (port of integrate-admin's db/day_ledger.py plus the file checks of
// db/pipeline.py and db/dataset.py).
//
// The partner's export has no call id, so "the same calls" is decided per day by the
// number of rows and a fingerprint: SHA-256 of the day's call lines, sorted, joined by
// '\n'. One line is
//
//   2026-10-20T08:00:00|5.000|300.000|0.000|5.000|0
//
// start_ts to the second, the four durations to three decimals (a missing value is the
// empty text, so it differs from 0), then abandoned as 1 or 0.
import { createHash } from 'node:crypto'
import { addDays, dateRange } from '../../../shared/utils/dates'
import type { DayPlan, DayStatus } from '../../../shared/types/api'
import { MAX_LISTED } from './limits'

export interface CallValues {
  startTs: string
  inQueueSec: number | null
  agentSec: number | null
  abandonSec: number | null
  routingSec: number | null
  abandoned: boolean
}

export interface DaySummary {
  rows: number
  fingerprint: string
}

const DURATION_DECIMALS = 3
const SCALE = 10 ** DURATION_DECIMALS
// A day that has no call in its first EDGE_HOURS hours (first day of a file) or in its
// last EDGE_HOURS hours (last day) looks cut short (db/dataset.py EDGE_HOURS).
const EDGE_HOURS = 3
const HOURS_PER_DAY = 24

// Half to even, as pandas' round() does on the scaled value.
function roundHalfEven(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function duration(value: number | null): string {
  if (value === null) return ''
  return (roundHalfEven(value * SCALE) / SCALE + 0).toFixed(DURATION_DECIMALS)
}

export function callLine(call: CallValues): string {
  return [
    call.startTs.slice(0, 19),
    duration(call.inQueueSec),
    duration(call.agentSec),
    duration(call.abandonSec),
    duration(call.routingSec),
    call.abandoned ? '1' : '0',
  ].join('|')
}

export function dayOf(startTs: string): string {
  return startTs.slice(0, 10)
}

export function fingerprint(lines: string[]): string {
  // Lines are ASCII, so the default sort orders them as Python's sorted() does.
  return createHash('sha256').update(lines.slice().sort().join('\n')).digest('hex')
}

export function summarizeDays(calls: Iterable<CallValues>): Map<string, DaySummary> {
  const lines = new Map<string, string[]>()
  for (const call of calls) {
    const day = dayOf(call.startTs)
    const dayLines = lines.get(day)
    if (dayLines) dayLines.push(callLine(call))
    else lines.set(day, [callLine(call)])
  }
  const summaries = new Map<string, DaySummary>()
  for (const day of [...lines.keys()].sort()) {
    const dayLines = lines.get(day)!
    summaries.set(day, { rows: dayLines.length, fingerprint: fingerprint(dayLines) })
  }
  return summaries
}

// Every day of the file, oldest first. Days only `calls` has are not mentioned.
export function planDays(
  fileDays: Map<string, DaySummary>,
  storedDays: Map<string, DaySummary>
): DayPlan[] {
  return [...fileDays.keys()].sort().map((day) => {
    const file = fileDays.get(day)!
    const stored = storedDays.get(day)
    let status: DayStatus = 'new'
    if (stored) {
      status =
        stored.rows === file.rows && stored.fingerprint === file.fingerprint
          ? 'identical'
          : 'conflict'
    }
    return { day, rows: file.rows, existing_rows: stored?.rows ?? 0, status }
  })
}

// hoursByDay: for each day of the file, the hours (0..23) that have at least one call.
export function partialEdgeDays(hoursByDay: Map<string, Iterable<number>>): string[] {
  const days = [...hoursByDay.keys()].sort()
  if (days.length === 0) return []
  const first = days[0]!
  const last = days[days.length - 1]!
  const flagged = new Set<string>()
  if (Math.min(...hoursByDay.get(first)!) >= EDGE_HOURS) flagged.add(first)
  if (Math.max(...hoursByDay.get(last)!) < HOURS_PER_DAY - EDGE_HOURS) flagged.add(last)
  return [...flagged].sort()
}

// Dates between the first and the last day that have no call at all. The line is open
// around the clock, so such a date is unreported, not a quiet day.
export function daysWithoutCalls(days: string[]): string[] {
  if (days.length === 0) return []
  const present = new Set(days)
  const sorted = [...present].sort()
  return dateRange(sorted[0]!, sorted[sorted.length - 1]!).filter((day) => !present.has(day))
}

// Days for a message: at most MAX_LISTED, then "and <n> more".
export function listDays(days: Iterable<string>): string {
  const sorted = [...days].sort()
  const more = sorted.length - MAX_LISTED
  return sorted.slice(0, MAX_LISTED).join(', ') + (more > 0 ? ` and ${more} more` : '')
}

export function nextDay(day: string): string {
  return addDays(day, 1)
}
