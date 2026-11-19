// Parity rung P1 (PLAN.md section 12): the TypeScript staffing arithmetic equals
// final-main's Python on final-main's own grid (tests/test_erlang_js.py), crossed with
// both shift caps. Floats within 1e-9 (abs and rel), everything else exact.
// Needs forecast/.venv (pnpm forecast:setup); without it this test fails, never skips.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll } from 'vitest'
import { erlangA, erlangC } from '#shared/utils/erlang'
import {
  plannedOutcome,
  schedulePeople,
  staffForHour,
  verdict,
  type HourStaffing,
} from '#shared/utils/staffing'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const REFERENCE = fileURLToPath(new URL('./reference.py', import.meta.url))
const PYTHON = process.env.V4W_PYTHON ?? 'forecast/.venv/bin/python'
const TOLERANCE = 1e-9

const CALLS = [0, 0.5, 1, 2.5, 5, 10, 30, 60]
const AHT_SEC = [300, 600, 936, 1200]
const EFFICIENCY = [0, 0.01, 0.2, 0.65, 1.0]
const TARGET_PCT = [0.8, 0.9, 0.95]
const TARGET_SEC = [20, 30, 45]
const PATIENCE_SEC = [null, 60, 400]
const CAPS = [7, 6]

interface StaffCase {
  calls: number
  aht: number
  efficiency: number
  target_pct: number
  target_sec: number
  patience_sec: number | null
  cap: number
}
interface ErlangACase {
  agents: number
  load: number
  aht: number
  patience: number
  target: number
}
interface PlannedCase {
  rows: { load_erlangs: number; aht_sec: number }[]
  planned: number
  efficiency: number
  target_sec: number
  patience_sec: number | null
}
type PyError = { error: string }
type PyResults = {
  staff_for_hour: (Record<string, unknown> | PyError)[]
  erlang_a: (Record<string, number> | PyError)[]
  erlang_c: (number | PyError)[]
  planned_outcome: (Record<string, number | null> | PyError)[]
  verdict: (string | PyError)[]
  schedule_people: ([number | null, number | null] | PyError)[]
}

const staffCases: StaffCase[] = []
for (const calls of CALLS)
  for (const aht of AHT_SEC)
    for (const efficiency of EFFICIENCY)
      for (const target_pct of TARGET_PCT)
        for (const target_sec of TARGET_SEC)
          for (const patience_sec of PATIENCE_SEC)
            for (const cap of CAPS)
              staffCases.push({ calls, aht, efficiency, target_pct, target_sec, patience_sec, cap })

const erlangACases: ErlangACase[] = []
for (let agents = 0; agents <= 12; agents++)
  for (const load of [0, 0.3, 1.7, 4.2, 9.5])
    for (const target of [0, 20, 30])
      erlangACases.push({ agents, load, aht: 600, patience: 400, target })

const erlangCCases = erlangACases
  .filter((c) => c.target === 0)
  .map(({ agents, load }) => ({ agents, load }))

const hour = (calls: number, aht: number) => ({ load_erlangs: (calls * aht) / 3600, aht_sec: aht })
const plannedCases: PlannedCase[] = [
  // a quiet Overnight: eight core hours plus the boundary hour
  {
    rows: [1.2, 0.8, 0.5, 0.4, 0.4, 0.7, 1.5, 3.1, 6.2].map((c) => hour(c, 640)),
    planned: 4,
    efficiency: 0.65625,
    target_sec: 30,
    patience_sec: 251,
  },
  // a busy Day under Erlang C
  {
    rows: [9, 12, 14, 15, 14, 13, 12, 11, 10].map((c, i) => hour(c, 600 + 20 * i)),
    planned: 6,
    efficiency: 0.65625,
    target_sec: 30,
    patience_sec: null,
  },
  // an Evening at the cap, every hour short
  {
    rows: [10, 11, 9, 8, 7, 6, 5, 4, 3].map((c) => hour(c, 936)),
    planned: 6,
    efficiency: 0.5,
    target_sec: 20,
    patience_sec: 400,
  },
]

const verdictCases: { planned: number; recommended: number; cap: number }[] = []
for (let planned = 0; planned <= 9; planned++)
  for (let recommended = 0; recommended <= 9; recommended++)
    for (const cap of CAPS) verdictCases.push({ planned, recommended, cap })

const scheduleCases: { agents: number; efficiency: number }[] = []
for (let agents = 0; agents <= 20; agents++)
  for (const efficiency of [0, 0.01, 0.2, 0.65, 0.65625, 1])
    scheduleCases.push({ agents, efficiency })

// staff_for_hour key (Python) for each HourStaffing field (TypeScript)
const FIELD_MAP: [keyof HourStaffing, string][] = [
  ['load_erlangs', 'offered_load_erlangs'],
  ['agents_required', 'agents_required'],
  ['staff_to_schedule', 'scheduled_needed'],
  ['effective_agents', 'effective_agents'],
  ['service_level_delivered', 'service_level_at_scheduled'],
  ['over_cap', 'capped'],
  ['implausible', 'implausible'],
  ['reason', 'reason'],
  ['abandon_share', 'abandon_share'],
  ['queue_model', 'queue_model'],
  ['patience_sec', 'patience_sec'],
]
const INTEGER_FIELDS = new Set(['agents_required', 'staff_to_schedule', 'effective_agents'])

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(TOLERANCE * Math.max(Math.abs(a), Math.abs(b)), TOLERANCE)
}

function same(ts: unknown, py: unknown, exact: boolean): boolean {
  if (typeof ts === 'number' && typeof py === 'number' && !exact) return close(ts, py)
  return ts === py
}

function isError(value: unknown): value is PyError {
  return typeof value === 'object' && value !== null && 'error' in value
}

function runPython(request: object): PyResults {
  const child = spawnSync(PYTHON, [REFERENCE], {
    cwd: REPO_ROOT,
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (child.error) {
    throw new Error(`cannot run ${PYTHON} (${child.error.message}): run pnpm forecast:setup first`)
  }
  if (child.status !== 0) {
    throw new Error(`reference.py exited with ${child.status}:\n${child.stderr}`)
  }
  return JSON.parse(child.stdout) as PyResults
}

describe('P1: TypeScript staffing equals the Python', () => {
  let py: PyResults

  beforeAll(() => {
    py = runPython({
      staff_for_hour: staffCases,
      erlang_a: erlangACases,
      erlang_c: erlangCCases,
      planned_outcome: plannedCases,
      verdict: verdictCases,
      schedule_people: scheduleCases,
    })
    // The Python grid takes about 20 s; hooks do not inherit the project's testTimeout.
  }, 180_000)

  it('covers the whole grid', () => {
    expect(staffCases.length).toBe(8 * 4 * 5 * 3 * 3 * 3 * 2)
    expect(py.staff_for_hour.length).toBe(staffCases.length)
    expect(py.erlang_a.length).toBe(13 * 5 * 3)
  })

  it('staffForHour matches staff_for_hour on every field', () => {
    const mismatches: unknown[] = []
    staffCases.forEach((c, i) => {
      const expected = py.staff_for_hour[i]!
      let actual: HourStaffing
      try {
        actual = staffForHour(
          c.calls,
          c.aht,
          c.efficiency,
          c.target_pct,
          c.target_sec,
          c.patience_sec,
          c.cap
        )
      } catch (error) {
        if (!isError(expected)) mismatches.push({ case: c, ts: String(error), py: expected })
        return
      }
      if (isError(expected)) {
        mismatches.push({ case: c, ts: 'no error', py: expected.error })
        return
      }
      for (const [tsKey, pyKey] of FIELD_MAP) {
        if (!same(actual[tsKey], expected[pyKey], INTEGER_FIELDS.has(tsKey))) {
          mismatches.push({ case: c, field: tsKey, ts: actual[tsKey], py: expected[pyKey] })
        }
      }
      if (actual.predicted_calls !== c.calls || actual.aht_sec !== c.aht) {
        mismatches.push({ case: c, field: 'inputs echoed', ts: actual })
      }
    })
    expect(mismatches.slice(0, 5)).toEqual([])
    expect(mismatches.length).toBe(0)
  })

  it('erlangA and erlangC match erlang_a and erlang_c', () => {
    const mismatches: unknown[] = []
    erlangACases.forEach((c, i) => {
      const expected = py.erlang_a[i]!
      if (isError(expected)) {
        mismatches.push({ case: c, py: expected.error })
        return
      }
      const actual = erlangA(c.agents, c.load, c.aht, c.patience, c.target)
      for (const key of ['wait_prob', 'abandon_prob', 'service_level'] as const) {
        if (!same(actual[key], expected[key], false)) {
          mismatches.push({ case: c, key, ts: actual[key], py: expected[key] })
        }
      }
    })
    erlangCCases.forEach((c, i) => {
      const expected = py.erlang_c[i]!
      const actual = erlangC(c.agents, c.load)
      if (isError(expected) || !same(actual, expected, false)) {
        mismatches.push({ case: c, ts: actual, py: expected })
      }
    })
    expect(mismatches.slice(0, 5)).toEqual([])
    expect(mismatches.length).toBe(0)
  })

  it('plannedOutcome matches planned_outcome on three shifts', () => {
    plannedCases.forEach((c, i) => {
      const expected = py.planned_outcome[i]!
      expect(isError(expected), JSON.stringify(expected)).toBe(false)
      const e = expected as Record<string, number | null>
      const actual = plannedOutcome(c.rows, c.planned, c.efficiency, c.target_sec, c.patience_sec)
      expect(actual.effective_agents).toBe(e.effective_agents)
      expect(close(actual.service_level_at_planned, e.service_level_at_planned as number)).toBe(
        true
      )
      if (e.abandon_share_at_planned === null) expect(actual.abandon_share_at_planned).toBeNull()
      else expect(close(actual.abandon_share_at_planned!, e.abandon_share_at_planned!)).toBe(true)
    })
  })

  it('verdict and schedulePeople match verdict and schedule_people', () => {
    expect(verdictCases.map((c) => verdict(c.planned, c.recommended, c.cap))).toEqual(py.verdict)
    expect(scheduleCases.map((c) => schedulePeople(c.agents, c.efficiency))).toEqual(
      py.schedule_people
    )
  })
})
