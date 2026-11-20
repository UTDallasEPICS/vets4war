// The checks of final-main's tests/web_checks.js + tests/test_web.py, re-expressed for
// the console's TypeScript logic, plus a few cases of its own.
import { describe, it, expect } from 'vitest'
import {
  CSV_COLUMNS,
  HOURS,
  SHIFTS,
  SHIFT_NAMES,
  STORAGE_KEY,
  VERDICTS,
  abandonedOneFewer,
  capForHour,
  capForShift,
  capState,
  clampedServiceLevel,
  computeHours,
  createPlannedStore,
  csvRows,
  dayStats,
  diffCells,
  discreteScale,
  judgeRoster,
  key,
  peakHours,
  plannedOutcome,
  rollupShifts,
  rosterOutcome,
  shiftKey,
  shiftOfHour,
  shiftTotals,
  shiftTradeoff,
  summarize,
  toCsv,
  verdict,
} from '../../../app/utils/console/logic'
import { fakeStorage, sampleWeek, SAMPLE_CONTROLS as c } from './fixtures'

const EXPECTED_HEADER =
  'date,hour,shift,predicted_calls,aht_sec,load_erlangs,agents_required,staff_to_schedule,' +
  'effective_agents,service_level_delivered,abandon_share,cap_state,service_level_if_capped,' +
  'planned_shift_staff,verdict,service_level_at_planned'
const RECOMPUTE_BUDGET_MS = 200

const { hours, days } = sampleWeek()
const computed = computeHours(hours, c)
const judged = judgeRoster(rollupShifts(days, computed), createPlannedStore(fakeStorage()), c)

describe('constants and keys', () => {
  it('match web/logic.js', () => {
    expect(HOURS).toEqual(Array.from({ length: 24 }, (_, i) => i))
    expect(SHIFT_NAMES).toEqual(['Overnight', 'Day', 'Evening'])
    expect(SHIFTS.map((s) => s.span)).toEqual([
      '00:00 to 08:30',
      '08:00 to 16:30',
      '16:00 to 00:30',
    ])
    expect(VERDICTS).toEqual(['understaffed', 'on target', 'overstaffed', 'exceeds capacity'])
    expect(STORAGE_KEY).toBe('v4w.planned.v1')
    expect(key('2026-10-05', 7)).toBe('2026-10-05:7')
    expect(shiftKey('2026-10-05', 'Day')).toBe('2026-10-05|Day')
    expect(CSV_COLUMNS.join(',')).toBe(EXPECTED_HEADER)
  })
})

describe('cap states', () => {
  it('are three distinct states plus undefined', () => {
    expect({
      under: capState(6),
      at: capState(7),
      over: capState(8),
      undef: capState(null),
    }).toEqual({ under: 'under', at: 'at', over: 'over', undef: 'undef' })
    expect(capState(undefined)).toBe('undef')
    expect(capState(6, 6)).toBe('at')
  })

  it('Evening is capped at 6, the other tours at 7', () => {
    expect([0, 8, 16, 23].map((h) => capForHour(h))).toEqual([7, 7, 6, 6])
    expect(verdict(7, 7, capForShift('Evening'))).toBe('exceeds capacity')
    expect(verdict(7, 7, capForShift('Day'))).toBe('on target')
    expect(computed.filter((h) => h.hour >= 16).every((h) => h.cap === 6)).toBe(true)
    expect(judged[0]!.shifts.Evening.cap).toBe(6)
  })

  it('an over-cap hour carries the service level at its cap, others null', () => {
    const busy = computeHours(
      [
        {
          date: '2026-10-05',
          hour: 20,
          predicted_calls: 40,
          predicted_real_calls: 24,
          aht_sec: 650,
        },
      ],
      c
    )[0]!
    expect(busy.cap_state).toBe('over')
    expect(busy.over_cap).toBe(true)
    expect(busy.service_level_if_capped).toBeCloseTo(clampedServiceLevel(busy, c, 6), 12)
    expect(computed.find((h) => h.cap_state !== 'over')!.service_level_if_capped).toBeNull()
  })
})

describe('planned store', () => {
  it('survives a simulated reload and clearing', () => {
    const backing = fakeStorage()
    const first = createPlannedStore(backing)
    first.set('2026-10-01', 'Day', 6)
    first.set('2026-10-02', 'Evening', 9)
    const reloaded = createPlannedStore(backing)
    expect({
      day: reloaded.get('2026-10-01', 'Day'),
      evening: reloaded.get('2026-10-02', 'Evening'),
      missing: reloaded.get('2026-10-03', 'Day'),
    }).toEqual({ day: 6, evening: 9, missing: null })
    reloaded.set('2026-10-01', 'Day', null)
    expect(createPlannedStore(backing).get('2026-10-01', 'Day')).toBeNull()
    expect(JSON.parse(backing.data[STORAGE_KEY]!)).toEqual({ '2026-10-02|Evening': 9 })
  })

  it('works in memory when storage throws, and with no storage', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const guarded = createPlannedStore(throwing)
    guarded.set('2026-10-01', 'Day', 4)
    expect({ get: guarded.get('2026-10-01', 'Day'), size: guarded.size() }).toEqual({
      get: 4,
      size: 1,
    })
    expect(createPlannedStore(null).get('2026-10-01', 'Day')).toBeNull()
  })

  it('ignores stored garbage', () => {
    const backing = fakeStorage()
    backing.setItem(STORAGE_KEY, '{"2026-10-01|Day":"6","2026-10-02|Day":2.5,"2026-10-03|Day":3}')
    const store = createPlannedStore(backing)
    expect(store.get('2026-10-01', 'Day')).toBeNull()
    expect(store.get('2026-10-02', 'Day')).toBeNull()
    expect(store.get('2026-10-03', 'Day')).toBe(3)
    backing.setItem(STORAGE_KEY, 'not json')
    expect(createPlannedStore(backing).size()).toBe(0)
    store.clear()
    expect(store.size()).toBe(0)
  })
})

describe('CSV export', () => {
  it('has the header and one line per hour', () => {
    const csv = toCsv(csvRows(computed, judged))
    const lines = csv.trim().split('\n')
    expect(csv.length).toBeGreaterThan(0)
    expect(lines[0]).toBe(EXPECTED_HEADER)
    expect(lines).toHaveLength(168 + 1)
    expect(lines[1]!.startsWith('2026-10-05,0,Overnight,')).toBe(true)
    expect(csv.endsWith('\n')).toBe(true)
  })

  it('quotes cells with commas, quotes or newlines and leaves nulls empty', () => {
    expect(toCsv([{ a: 'x,y', b: 'say "hi"', c: null }], ['a', 'b', 'c'])).toBe(
      'a,b,c\n"x,y","say ""hi""",\n'
    )
  })
})

describe('recompute', () => {
  it('stays under budget on the 168-hour grid', () => {
    const recompute = () => {
      const hrs = computeHours(hours, c)
      const rolled = judgeRoster(rollupShifts(days, hrs), createPlannedStore(fakeStorage()), c)
      const scale = discreteScale(hrs.map((h) => h.staff_to_schedule))
      return { hrs, rolled, scale, summary: summarize(hrs), fewer: abandonedOneFewer(hrs, c) }
    }
    recompute()
    const runs = 5
    const t0 = performance.now()
    let last = recompute()
    for (let i = 1; i < runs; i++) last = recompute()
    const ms = (performance.now() - t0) / runs
    expect(last.hrs).toHaveLength(168)
    expect(ms).toBeLessThan(RECOMPUTE_BUDGET_MS)
    expect(last.scale.steps).toBe(last.scale.hi - last.scale.lo + 1)
    expect(last.fewer!).toBeGreaterThan(last.summary.abandoned!)
    expect(last.rolled[0]!.planned.Day.verdict).toBe('on target')
  })

  it('counts changed cells', () => {
    const other = computeHours(hours, { ...c, efficiency: 0.5 })
    const n = diffCells(computed, other)
    expect(n).toBe(
      computed.filter((h, i) => h.staff_to_schedule !== other[i]!.staff_to_schedule).length
    )
    expect(n).toBeGreaterThan(0)
    expect(diffCells(computed, computed)).toBe(0)
    expect(diffCells([], computed)).toBe(168)
    expect(diffCells(null, computed)).toBe(168)
  })
})

describe('discrete scale', () => {
  it('has one step per integer of the under-cap range', () => {
    const s = discreteScale([2, 3, 5, 7, 9, null])
    expect([s.lo, s.hi, s.steps]).toEqual([2, 5, 4])
    expect([2, 3, 4, 5].map(s.levelOf)).toEqual([0, 1 / 3, 2 / 3, 1])
    expect(discreteScale([4, 4]).levelOf(4)).toBe(1)
    const empty = discreteScale([7, null])
    expect([empty.lo, empty.hi, empty.steps, empty.levelOf(3)]).toEqual([0, 0, 1, 0])
  })
})

describe('verdicts and consequences', () => {
  it('cover the four cases', () => {
    expect({
      under: verdict(4, 5),
      on: verdict(5, 5),
      over: verdict(6, 5),
      beyond: verdict(8, 5),
    }).toEqual({
      under: 'understaffed',
      on: 'on target',
      over: 'overstaffed',
      beyond: 'exceeds capacity',
    })
  })

  it('a smaller roster lowers the service level', () => {
    const day = judged[0]!.shifts.Day
    const rec = day.staff_needed!
    expect(plannedOutcome(day.hours, rec - 1, c).service_level!).toBeLessThan(
      plannedOutcome(day.hours, rec, c).service_level!
    )
  })

  it('plannedOutcome gives nulls at efficiency 0 or with no rows', () => {
    const none = { effective_agents: null, service_level: null, abandon_share: null }
    expect(plannedOutcome([], 4, c)).toEqual(none)
    expect(plannedOutcome(judged[0]!.shifts.Day.hours, 4, { ...c, efficiency: 0 })).toEqual(none)
  })

  it('one fewer person every hour raises hang-ups', () => {
    expect(abandonedOneFewer(computed, c)!).toBeGreaterThan(summarize(computed).abandoned!)
    expect(abandonedOneFewer(computed, { ...c, patienceSec: null })).toBeNull()
  })

  it('judgeRoster follows the recommendation until a number is stored', () => {
    const store = createPlannedStore(fakeStorage())
    store.set('2026-10-05', 'Day', 9)
    const j = judgeRoster(rollupShifts(days, computed), store, c)[0]!
    expect(j.planned.Overnight.is_own).toBe(false)
    expect(j.planned.Overnight.planned).toBe(j.shifts.Overnight.staff_needed)
    expect(j.planned.Overnight.delta).toBe(0)
    expect(j.planned.Day).toMatchObject({ planned: 9, is_own: true, verdict: 'exceeds capacity' })
    expect(j.planned.Day.delta).toBe(9 - j.shifts.Day.staff_needed!)
    expect(j.planned.Day.totals!.staff).toBe(9)
    expect(j.planned.Day.recommendedTotals!.staff).toBe(j.shifts.Day.staff_needed)
  })
})

describe('shift roll-up', () => {
  it('takes the overlap hour into the peak, calls from core hours only', () => {
    const rolled = rollupShifts(days, computed)
    const first = rolled[0]!
    const dayHours = computed.filter((h) => h.date === '2026-10-05')
    const core = dayHours.filter((h) => h.hour >= 8 && h.hour < 16)
    const withBoundary = [...core, dayHours.find((h) => h.hour === 16)!]
    expect(first.shifts.Day.staff_needed).toBe(
      Math.max(...withBoundary.map((h) => h.staff_to_schedule!))
    )
    expect(first.shifts.Day.predicted_calls).toBeCloseTo(
      core.reduce((a, h) => a + h.predicted_calls, 0),
      12
    )
    // Evening's overlap is hour 0 of the next date; the last date has none.
    expect(first.shifts.Evening.hours).toHaveLength(9)
    expect(rolled[6]!.shifts.Evening.hours).toHaveLength(8)
    expect(first.person_hours).toBe(dayHours.reduce((a, h) => a + h.staff_to_schedule!, 0))
  })

  it('is undefined at efficiency 0', () => {
    const zero = { ...c, efficiency: 0 }
    const rolled = rollupShifts(days, computeHours(hours, zero))
    expect(rolled[0]!.shifts.Day).toMatchObject({
      staff_needed: null,
      capped: null,
      person_hours: null,
      service_level_delivered: null,
      abandon_share: null,
    })
    expect(rolled[0]!.person_hours).toBeNull()
  })
})

describe('roster outcome', () => {
  it('more people means fewer hang-ups and a better service level', () => {
    const s = summarize(computed)
    const small = rosterOutcome(computed, { Overnight: 3, Day: 3, Evening: 4 }, c)!
    const real = rosterOutcome(computed, { Overnight: 4, Day: 4, Evening: 6 }, c)!
    expect(Math.abs(real.calls - s.calls)).toBeLessThan(1e-9)
    expect(real.abandoned).toBeLessThan(small.abandoned)
    expect(real.serviceLevel!).toBeGreaterThan(small.serviceLevel!)
    expect(real.abandonShare!).toBeGreaterThanOrEqual(0)
    expect(real.abandonShare!).toBeLessThanOrEqual(1)
    expect(real.serviceLevel!).toBeLessThanOrEqual(1)
    expect(
      rosterOutcome(computed, { Overnight: 4, Day: 4, Evening: 6 }, { ...c, efficiency: 0 })
    ).toBeNull()
  })
})

describe('trade-off table', () => {
  const eve = judged[0]!.shifts.Evening
  const table = shiftTradeoff(eve.core_hours, eve.cap, c)
  const t4 = shiftTotals(eve.core_hours, 4, c)!

  it('runs from 1 to the cap and moves the right way', () => {
    expect(table.map((r) => r.staff)).toEqual([1, 2, 3, 4, 5, 6])
    expect(table.every((r, i) => i === 0 || r.lost <= table[i - 1]!.lost + 1e-9)).toBe(true)
    expect(
      table.every((r, i) => i === 0 || r.serviceLevel! >= table[i - 1]!.serviceLevel! - 1e-9)
    ).toBe(true)
  })

  it('adds up and counts each call once', () => {
    expect(Math.abs(t4.lost + t4.inTime + t4.late - t4.calls)).toBeLessThan(1e-6)
    expect(Math.abs(t4.calls - eve.predicted_calls)).toBeLessThan(1e-9)
    expect(judged[0]!.planned.Evening.totals).not.toBeNull()
    expect(shiftTotals(eve.core_hours, 4, { ...c, efficiency: 0 })).toBeNull()
    expect(shiftTradeoff(eve.core_hours, eve.cap, { ...c, efficiency: 0 })).toEqual([])
  })
})

describe('summaries', () => {
  it('sum real calls per hour, below the total', () => {
    const s = summarize(computed)
    expect(s.realCalls).toBeCloseTo(
      hours.reduce((a, h) => a + h.predicted_real_calls, 0),
      9
    )
    expect(s.realCalls).toBeLessThan(s.calls)
    expect(s.n).toBe(168)
    expect(s.meanAht).toBeCloseTo(s.talkSec / s.calls, 12)
  })

  it('are undefined where staffing is', () => {
    const s = summarize(computeHours(hours, { ...c, efficiency: 0 }))
    expect([s.personHours, s.peakStaff, s.abandoned]).toEqual([null, null, null])
    expect(summarize([])).toMatchObject({ n: 0, calls: 0, meanAht: null, peakStaff: null })
  })

  it('dayStats finds the busiest hour and the cap hours', () => {
    const dayHours = computed.filter((h) => h.date === '2026-10-05')
    const st = dayStats(judged[0]!, dayHours)
    const busiest = dayHours.reduce((a, b) => (b.predicted_calls > a.predicted_calls ? b : a))
    expect(st.peakHour).toBe(busiest.hour)
    expect(st.atCap).toEqual(dayHours.filter((h) => h.cap_state === 'at').map((h) => h.hour))
    expect(st.overCap).toEqual(dayHours.filter((h) => h.cap_state === 'over').map((h) => h.hour))
    expect(dayStats(judged[0]!, []).peakHour).toBeNull()
  })

  it('peakHours ranks hours by mean calls', () => {
    const peaks = peakHours(computed)
    expect(peaks).toHaveLength(4)
    const mean = (h: number) => {
      const rows = computed.filter((r) => r.hour === h)
      return rows.reduce((a, r) => a + r.predicted_calls, 0) / rows.length
    }
    const ranked = [...HOURS].sort((a, b) => mean(b) - mean(a))
    expect(peaks).toEqual(ranked.slice(0, 4))
    expect(peakHours([])).toEqual([])
  })

  it('shiftOfHour follows the core hours', () => {
    expect([0, 7, 8, 15, 16, 23].map(shiftOfHour)).toEqual([
      'Overnight',
      'Overnight',
      'Day',
      'Day',
      'Evening',
      'Evening',
    ])
  })
})
