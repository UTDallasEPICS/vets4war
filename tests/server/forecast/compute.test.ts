import { describe, expect, it } from 'vitest'
import {
  equalWeightTalkSec,
  forecastDays,
  holidayCoverage,
  hourRows,
  judgePlanned,
  resolvePatience,
  rollupShifts,
  staffingDays,
  windowSummary,
} from '../../../server/utils/forecast/compute'
import type { CellTable } from '../../../server/utils/forecast/store'
import { abandonShare, staffForHour } from '../../../shared/utils/staffing'
import { dateRange } from '../../../shared/utils/dates'
import type { HourRow } from '../../../shared/types/api'
import { caught } from './helpers'

const DEFAULTS = {
  start: '2026-12-01',
  end: '2026-12-02',
  efficiency: 0.65625,
  targetPct: 0.8,
  targetSec: 30,
  queueModel: 'erlang_a' as const,
  patienceSec: null,
  recency: 'weighted' as const,
  includeHolidays: true,
}

// A hand-built hour: only the fields the roll-up and summaries read matter.
function row(date: string, hour: number, over: Partial<HourRow> = {}): HourRow {
  return {
    date,
    hour,
    predicted_calls: 10,
    predicted_real_calls: 7,
    aht_sec: 600,
    load_erlangs: 10 * (600 / 3600),
    agents_required: 3,
    staff_to_schedule: 5,
    effective_agents: 3,
    service_level_delivered: 0.9,
    over_cap: false,
    implausible: false,
    reason: null,
    expected_talk_sec: 6000,
    expected_talk: '1h 40m',
    abandon_share: 0.05,
    ...over,
  }
}

const day = (date: string, over: (hour: number) => Partial<HourRow> = () => ({})) =>
  Array.from({ length: 24 }, (_, h) => row(date, h, over(h)))

function cells(aht: Record<'equal' | 'weighted' | 'recent', number>): CellTable {
  const make = (value: number) =>
    Array.from({ length: 168 }, () => ({ ahtSec: value, realShare: 0.5 }))
  return { equal: make(aht.equal), weighted: make(aht.weighted), recent: make(aht.recent) }
}

function stored(dates: string[], calls: (date: string, hour: number) => number) {
  return dates.flatMap((date) =>
    Array.from({ length: 24 }, (_, hour) => ({
      date,
      hour,
      predictedCalls: calls(date, hour),
      predictedCallsNoHolidays: calls(date, hour) / 2,
    }))
  )
}

describe('resolvePatience', () => {
  const state = { patienceSec: 251, patienceNAbandoned: 57, patienceNCalls: 389 }

  it('uses the stored estimate with its counts by default', () => {
    expect(resolvePatience({ queueModel: 'erlang_a', patienceSec: null }, state)).toEqual({
      patienceSec: 251,
      source: { kind: 'estimated', n_abandoned: 57, n_calls: 389 },
    })
  })

  it('uses an override when given', () => {
    expect(resolvePatience({ queueModel: 'erlang_a', patienceSec: 60 }, state)).toEqual({
      patienceSec: 60,
      source: { kind: 'override' },
    })
  })

  // Review finding N-5: the stored estimate is not a request field, so the parameter
  // bounds never saw it; a tiny one made every default request cost seconds per day.
  it.each([9.99, 2, 0.5, 0, -1, Number.NaN])(
    'refuses to compute with a stored estimate of %s s, quickly and plainly',
    (stored) => {
      const error = caught(() =>
        resolvePatience({ queueModel: 'erlang_a', patienceSec: null }, { ...state, patienceSec: stored })
      )
      expect(error.statusCode).toBe(503)
      expect(error.data.code).toBe('implausible_patience')
      expect(error.message).toContain('implausibly small')
      expect(error.message).toContain('reload the call data and run a retrain')
      expect(error.message).toContain('patience_sec')
    }
  )

  it('still serves an override or Erlang C when the stored estimate is implausible', () => {
    const broken = { ...state, patienceSec: 0.5 }
    expect(resolvePatience({ queueModel: 'erlang_a', patienceSec: 60 }, broken).patienceSec).toBe(60)
    expect(resolvePatience({ queueModel: 'erlang_c', patienceSec: null }, broken).patienceSec).toBe(
      null
    )
  })

  it('accepts a stored estimate at the minimum and a very patient line', () => {
    for (const stored of [10, 3600, 86400]) {
      expect(
        resolvePatience({ queueModel: 'erlang_a', patienceSec: null }, { ...state, patienceSec: stored })
          .patienceSec
      ).toBe(stored)
    }
  })

  it('has no patience under Erlang C, override or not', () => {
    expect(resolvePatience({ queueModel: 'erlang_c', patienceSec: 60 }, state)).toEqual({
      patienceSec: null,
      source: null,
    })
  })
})

describe('hourRows', () => {
  const snapshot = {
    hours: stored(['2026-12-01'], (_d, h) => (h === 18 ? 40 : 10)),
    cells: cells({ equal: 600, weighted: 660, recent: 720 }),
  }

  it('runs staffForHour on the stored calls and the cell of the recency', () => {
    const hours = hourRows(snapshot, DEFAULTS, 250)
    expect(hours).toHaveLength(24)
    const expected = staffForHour(10, 660, 0.65625, 0.8, 30, 250, 7)
    expect(hours[3]).toEqual({
      date: '2026-12-01',
      hour: 3,
      predicted_calls: 10,
      predicted_real_calls: 5,
      aht_sec: 660,
      load_erlangs: expected.load_erlangs,
      agents_required: expected.agents_required,
      staff_to_schedule: expected.staff_to_schedule,
      effective_agents: expected.effective_agents,
      service_level_delivered: expected.service_level_delivered,
      over_cap: expected.over_cap,
      implausible: false,
      reason: null,
      expected_talk_sec: expected.load_erlangs * 3600,
      expected_talk: '1h 50m',
      abandon_share: expected.abandon_share,
    })
  })

  it('reads the no-holidays column when holidays are excluded', () => {
    const hours = hourRows(snapshot, { ...DEFAULTS, includeHolidays: false }, 250)
    expect(hours[0]?.predicted_calls).toBe(5)
  })

  it('flags over_cap against 6 in the evening and 7 elsewhere', () => {
    // 40 calls at 660 s need 7 or more people in hour 18.
    const hours = hourRows(snapshot, DEFAULTS, 250)
    const evening = hours[18] as HourRow
    expect(evening.staff_to_schedule).toBeGreaterThan(6)
    expect(evening.over_cap).toBe(true)
    const day7 = hourRows(
      { ...snapshot, hours: stored(['2026-12-01'], () => 40) },
      DEFAULTS,
      250
    )[10] as HourRow
    expect(day7.over_cap).toBe((day7.staff_to_schedule as number) > 7)
  })

  it('leaves scheduling undefined at efficiency 0', () => {
    const hours = hourRows(snapshot, { ...DEFAULTS, efficiency: 0 }, 250)
    for (const h of hours) {
      expect(h.staff_to_schedule).toBeNull()
      expect(h.effective_agents).toBeNull()
      expect(h.service_level_delivered).toBeNull()
      expect(h.over_cap).toBeNull()
      expect(h.abandon_share).toBeNull()
      expect(h.reason).toContain('efficiency is 0')
    }
  })

  it('has no abandonment under Erlang C', () => {
    const hours = hourRows(snapshot, DEFAULTS, null)
    expect(hours.every((h) => h.abandon_share === null)).toBe(true)
  })
})

describe('rollupShifts', () => {
  it('rolls one day into three shifts; the boundary hour joins the staffing max only', () => {
    const hours = day('2026-12-01', (h) =>
      h === 8 ? { staff_to_schedule: 9, predicted_calls: 100 } : {}
    )
    const [d] = rollupShifts(hours)
    expect(d?.shifts.map((s) => s.name)).toEqual(['Overnight', 'Day', 'Evening'])
    const [overnight, dayShift, evening] = d!.shifts
    expect(overnight!.members.map((m) => m.hour)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(overnight!.rollup.staff_needed).toBe(9) // hour 8 is Overnight's boundary
    expect(overnight!.rollup.predicted_calls).toBe(80) // but its calls are Day's
    expect(dayShift!.rollup.predicted_calls).toBe(170)
    expect(dayShift!.members.map((m) => m.hour)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16])
    // the last date's Evening has no next-day hour 0 in the range
    expect(evening!.members.map((m) => m.hour)).toEqual([16, 17, 18, 19, 20, 21, 22, 23])
  })

  it("takes hour 0 of the next date as the Evening's boundary inside the range", () => {
    const hours = [
      ...day('2026-12-01'),
      ...day('2026-12-02', (h) => (h === 0 ? { staff_to_schedule: 8, agents_required: 6 } : {})),
    ]
    const [first, second] = rollupShifts(hours)
    const evening = first!.shifts[2]!
    expect(evening.members.map((m) => `${m.date} ${m.hour}`)).toContain('2026-12-02 0')
    expect(evening.rollup.staff_needed).toBe(8)
    expect(evening.rollup.agents_required).toBe(6)
    expect(evening.rollup.capped).toBe(true) // 8 > 6 in the evening
    expect(evening.rollup.predicted_calls).toBe(80) // calls of 16..23 only
    expect(second!.shifts[0]!.rollup.staff_needed).toBe(8) // hour 0 is also Overnight core
  })

  it('drops the Evening shift of the day before the first date', () => {
    const rolled = rollupShifts(day('2026-12-01'))
    expect(rolled.map((d) => d.date)).toEqual(['2026-12-01'])
  })

  it('keeps only shifts with a core hour in the range', () => {
    const rolled = rollupShifts([row('2026-12-01', 23), row('2026-12-02', 0)])
    expect(rolled.map((d) => [d.date, d.shifts.map((s) => s.name)])).toEqual([
      ['2026-12-01', ['Evening']],
      ['2026-12-02', ['Overnight']],
    ])
    expect(staffingDays(rolled)[0]?.shifts).toEqual({
      Overnight: null,
      Day: null,
      Evening: expect.objectContaining({ predicted_calls: 10 }),
    })
  })

  it('caps Evening at 6 and the other shifts at 7', () => {
    const [d] = rollupShifts(day('2026-12-01', () => ({ staff_to_schedule: 7 })))
    expect(d!.shifts.map((s) => s.rollup.capped)).toEqual([false, false, true])
  })

  it('takes the min service level and the max known abandonment', () => {
    const [d] = rollupShifts(
      day('2026-12-01', (h) =>
        h === 3
          ? { service_level_delivered: 0.81, abandon_share: 0.2 }
          : h === 4
            ? { abandon_share: null }
            : {}
      )
    )
    expect(d!.shifts[0]!.rollup.service_level_delivered).toBe(0.81)
    expect(d!.shifts[0]!.rollup.abandon_share).toBe(0.2)
  })

  it('is null for staffing at efficiency 0 and for abandonment under Erlang C', () => {
    const [d] = rollupShifts(
      day('2026-12-01', () => ({
        staff_to_schedule: null,
        effective_agents: null,
        service_level_delivered: null,
        over_cap: null,
        abandon_share: null,
      }))
    )
    for (const s of d!.shifts) {
      expect(s.rollup.staff_needed).toBeNull()
      expect(s.rollup.capped).toBeNull()
      expect(s.rollup.service_level_delivered).toBeNull()
      expect(s.rollup.abandon_share).toBeNull()
      expect(s.rollup.agents_required).toBe(3)
    }
  })

  it("rounds each shift's calls and rounds the day from the unrounded sums", () => {
    // 8 hours of 0.12555 = 1.0044 per shift: each shift rounds to 1, the day to 3.01.
    const rolled = rollupShifts(day('2026-12-01', () => ({ predicted_calls: 0.12555 })))
    const [d] = staffingDays(rolled)
    expect(d!.shifts.Overnight!.predicted_calls).toBe(1)
    expect(d!.predicted_calls).toBe(3.01)
  })
})

describe('forecastDays', () => {
  it('adds weekend, holiday and the talk time of all 24 hours', () => {
    const hours = [...day('2026-12-25'), ...day('2026-12-26')]
    const days = forecastDays(
      rollupShifts(hours),
      hours,
      new Map([['2026-12-25', 'Christmas Day']])
    )
    expect(days.map((d) => [d.date, d.is_weekend, d.holiday])).toEqual([
      ['2026-12-25', false, 'Christmas Day'],
      ['2026-12-26', true, null],
    ])
    expect(days[0]!.expected_talk_sec).toBeCloseTo(24 * 6000, 6)
    expect(days[0]!.expected_talk).toBe('40h 0m')
    expect(Object.keys(days[0]!)).toEqual([
      'date',
      'is_weekend',
      'holiday',
      'predicted_calls',
      'expected_talk_sec',
      'expected_talk',
      'shifts',
    ])
  })
})

describe('windowSummary', () => {
  const input = { start: '2026-12-01', end: '2026-12-01', efficiency: 0.5, targetSec: 30 }

  it('sums calls, talk time and expected hang-ups over the window', () => {
    const hours = day('2026-12-01', (h) => ({ abandon_share: h < 12 ? 0.1 : null }))
    const w = windowSummary(hours, { ...input, recency: 'weighted' }, 250, 24 * 6000 * 0.5)
    expect(w.expected_calls).toBe(240)
    expect(w.expected_talk_sec).toBeCloseTo(144000, 6)
    expect(w.expected_talk).toBe('40h 0m')
    expect(w.mean_aht_sec).toBeCloseTo(600, 9)
    expect(w.expected_abandoned_calls).toBeCloseTo(12 * 10 * 0.1, 12)
    expect(w.abandon_share).toBeCloseTo(12 / 240, 12)
    expect(w.recency_effect_pct).toBeCloseTo(100, 9)
    expect(w.caveat).toContain('excludes outbound')
  })

  it('evaluates one person fewer per hour', () => {
    const hours = [row('2026-12-01', 0, { staff_to_schedule: 4 })]
    const w = windowSummary(hours, { ...input, recency: 'weighted' }, 250, 6000)
    const share = abandonShare(Math.floor(3 * 0.5), 10 / 6, 600, 30, 250) as number
    expect(w.expected_abandoned_one_fewer).toBeCloseTo(10 * share, 12)
  })

  it('has no hang-up numbers under Erlang C or at efficiency 0', () => {
    const none = [row('2026-12-01', 0, { abandon_share: null })]
    const c = windowSummary(none, { ...input, recency: 'weighted' }, null, 6000)
    expect(c.expected_abandoned_calls).toBeNull()
    expect(c.abandon_share).toBeNull()
    expect(c.expected_abandoned_one_fewer).toBeNull()
    const zero = windowSummary(
      [row('2026-12-01', 0, { staff_to_schedule: null, abandon_share: null })],
      { ...input, efficiency: 0, recency: 'weighted' },
      250,
      6000
    )
    expect(zero.expected_abandoned_one_fewer).toBeNull()
  })

  it('reports no recency effect when the reference is 0', () => {
    const w = windowSummary([row('2026-12-01', 0)], { ...input, recency: 'weighted' }, 250, 0)
    expect(w.recency_effect_pct).toBe(0)
  })
})

describe('equalWeightTalkSec', () => {
  const table = cells({ equal: 600, weighted: 660, recent: 720 })

  it('multiplies the same calls by the equal-weight handle time', () => {
    const hours = [row('2026-12-01', 0, { predicted_calls: 10 })]
    expect(equalWeightTalkSec({ cells: table }, { recency: 'recent' }, hours)).toBe(6000)
  })

  it('is the window talk time itself under equal weighting, so the effect is 0', () => {
    const hours = hourRows(
      { hours: stored(['2026-12-01'], () => 10), cells: table },
      { ...DEFAULTS, recency: 'equal' },
      250
    )
    const equal = equalWeightTalkSec({ cells: table }, { recency: 'equal' }, hours)
    const w = windowSummary(hours, { ...DEFAULTS, recency: 'equal' }, 250, equal)
    expect(w.recency_effect_pct).toBe(0)
  })

  it('moves the talk time by the handle-time ratio for the other presets', () => {
    const hours = hourRows(
      { hours: stored(['2026-12-01'], () => 10), cells: table },
      { ...DEFAULTS, recency: 'recent' },
      250
    )
    const equal = equalWeightTalkSec({ cells: table }, { recency: 'recent' }, hours)
    const w = windowSummary(hours, { ...DEFAULTS, recency: 'recent' }, 250, equal)
    expect(w.recency_effect_pct).toBeCloseTo((720 / 600 - 1) * 100, 9)
  })
})

describe('holidayCoverage', () => {
  it('is covered through the last known holiday', () => {
    expect(holidayCoverage('2027-12-25', '2027-12-25')).toEqual({
      last_known_holiday: '2027-12-25',
      covered: true,
      message: null,
    })
  })

  it('says verbatim what is missing after it', () => {
    expect(holidayCoverage('2027-12-25', '2028-01-05')).toEqual({
      last_known_holiday: '2027-12-25',
      covered: false,
      message:
        'Holiday calendar ends 2027-12-25. Holidays after that date are not reflected in ' +
        'this forecast; load them into the holidays table.',
    })
  })
})

describe('judgePlanned', () => {
  const hours = dateRange('2026-12-01', '2026-12-02').flatMap((d) =>
    day(d, (h) => ({ staff_to_schedule: h >= 16 ? 6 : 5 }))
  )
  const rolled = rollupShifts(hours)
  const input = { efficiency: 0.5, targetSec: 30 }
  const judge = (planned: { date: string; shift: 'Overnight' | 'Day' | 'Evening'; planned: number }[]) =>
    judgePlanned(hours, rolled, { ...input, planned }, 250)

  it('gives the four verdicts with recommendation, delta and cap', () => {
    const results = judge([
      { date: '2026-12-01', shift: 'Overnight', planned: 5 },
      { date: '2026-12-01', shift: 'Evening', planned: 5 },
      { date: '2026-12-02', shift: 'Day', planned: 7 },
      { date: '2026-12-02', shift: 'Evening', planned: 7 },
    ])
    expect(results.map((r) => [r.recommended, r.delta, r.cap, r.verdict])).toEqual([
      [5, 0, 7, 'on target'],
      [6, -1, 6, 'understaffed'],
      [6, 1, 7, 'overstaffed'], // Day's boundary hour 16 asks for 6
      [6, 1, 6, 'exceeds capacity'],
    ])
    expect(Object.keys(results[0]!)).toEqual([
      'date',
      'shift',
      'planned',
      'recommended',
      'delta',
      'cap',
      'verdict',
      'effective_agents',
      'service_level_at_planned',
      'abandon_share_at_planned',
    ])
    expect(results[2]!.effective_agents).toBe(3)
  })

  it('refuses a roster at efficiency 0 before looking at the items', () => {
    const error = caught(() =>
      judgePlanned(
        hours,
        rolled,
        { ...input, efficiency: 0, planned: [{ date: '2027-01-01', shift: 'Day', planned: 1 }] },
        250
      )
    )
    expect(error.statusCode).toBe(400)
    expect(error.data.code).toBe('efficiency_zero')
    expect(error.message).toBe(
      'efficiency is 0: people to schedule is undefined, so there is no roster to judge'
    )
  })

  it('refuses a shift outside the window', () => {
    const error = caught(() => judge([{ date: '2026-12-09', shift: 'Day', planned: 4 }]))
    expect(error.statusCode).toBe(400)
    expect(error.data.code).toBe('outside_window')
    expect(error.message).toBe('2026-12-09 Day is not inside the forecast window')
  })
})

describe('a target no staffing level reaches', () => {
  const table = cells({ equal: 600, weighted: 660, recent: 720 })

  // Review finding W2-1: this ended in an unmapped RangeError (500). final-main: 400.
  it('answers 400 unreachable_target with a plain message', () => {
    const snapshot = { hours: stored(['2026-12-01'], () => 1e7), cells: table }
    const error = caught(() => hourRows(snapshot, DEFAULTS, null))
    expect(error.statusCode).toBe(400)
    expect(error.data.code).toBe('unreachable_target')
    expect(error.message).toBe(
      'No staffing level up to 1000 agents answers 0.8 of calls within 30 s on 2026-12-01 ' +
        'at 0:00; lower target_pct or raise target_sec.'
    )
  })

  it('leaves any other fault of the chain a fault', () => {
    const snapshot = { hours: stored(['2026-12-01'], () => -1), cells: table }
    expect(() => hourRows(snapshot, DEFAULTS, null)).toThrow(RangeError)
  })
})
