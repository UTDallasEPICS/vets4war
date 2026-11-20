// The error measures, against the numbers the old Python monitor's own tests pinned
// (tests/test_monitor.py on feature/admin-monitoring): one day predicted at 1 call an
// hour, 2 calls at 00:00 and 01:00 and none after.
import { describe, expect, it } from 'vitest'
import { scoreDay, scorePeriod, type DayInput } from '../../../server/utils/accuracy/metrics'

const hours = (value: number) => new Array<number>(24).fill(value)
const MONITOR_ACTUAL = [2, 2, ...hours(0).slice(2)]

function day(values: Partial<DayInput> = {}): DayInput {
  return {
    date: '2026-01-02',
    predicted: hours(1),
    actual: MONITOR_ACTUAL,
    source: 'replay',
    heldOut: true,
    ...values,
  }
}

describe('scorePeriod', () => {
  it("matches monitor.py's verified replay", () => {
    expect(scorePeriod([day()])).toEqual({
      days: 1,
      hours: 24,
      actual_calls: 4,
      predicted_calls: 24,
      hourly_mae: 1,
      hourly_rmse: 1,
      daily_total_mae: 20,
      signed_bias: 20 / 24,
      daily_accuracy_pct: 100 - 500,
      total_bias_pct: 500,
    })
  })

  it("matches monitor.py's calibrated (level factor 1.25) replay", () => {
    const metrics = scorePeriod([day({ predicted: hours(1.25) })])!
    expect(metrics.predicted_calls).toBeCloseTo(30)
    expect(metrics.daily_total_mae).toBeCloseTo(26)
    expect(metrics.signed_bias).toBeCloseTo(26 / 24)
    expect(metrics.hourly_mae).toBeCloseTo((2 * 0.75 + 22 * 1.25) / 24)
  })

  it('leaves out days the model was trained on, and is null without a held-out day', () => {
    const seen = day({ date: '2026-01-01', predicted: hours(100), heldOut: false })
    expect(scorePeriod([seen, day()])).toEqual(scorePeriod([day()]))
    expect(scorePeriod([seen])).toBeNull()
    expect(scorePeriod([])).toBeNull()
  })

  it('computes the daily accuracy on daily totals, a day without calls left out of it', () => {
    const busy = day({ date: '2026-01-02', predicted: hours(11), actual: hours(10) }) // +10%
    const quiet = day({ date: '2026-01-03', predicted: hours(0.8), actual: hours(1) }) // -20%
    const empty = day({ date: '2026-01-04', predicted: hours(1), actual: hours(0) })
    const metrics = scorePeriod([busy, quiet, empty])!
    expect(metrics.days).toBe(3)
    expect(metrics.daily_accuracy_pct).toBeCloseTo(85)
    // predicted 264 + 19.2 + 24, actual 240 + 24 + 0
    expect(metrics.total_bias_pct).toBeCloseTo((43.2 / 264) * 100)
  })

  it('has no percentages when no call came at all', () => {
    const metrics = scorePeriod([day({ actual: hours(0) })])!
    expect(metrics.daily_accuracy_pct).toBeNull()
    expect(metrics.total_bias_pct).toBeNull()
    expect(metrics.hourly_mae).toBe(1)
  })

  it('refuses a day that is not 24 hours', () => {
    expect(() => scorePeriod([day({ predicted: [1, 2, 3] })])).toThrow(RangeError)
  })
})

describe('scoreDay', () => {
  it('gives the totals, the signed error and the percentage error of one day', () => {
    expect(scoreDay(day({ source: 'snapshot' }))).toEqual({
      date: '2026-01-02',
      actual_calls: 4,
      predicted_calls: 24,
      error_calls: 20,
      abs_pct_error: 500,
      hourly_mae: 1,
      source: 'snapshot',
      held_out: true,
    })
  })

  it('has no percentage error on a day without calls', () => {
    expect(scoreDay(day({ actual: hours(0) })).abs_pct_error).toBeNull()
  })
})
