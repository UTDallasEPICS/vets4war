// Forecast against actual calls: the error measures the old Python monitor reported
// (db/monitor.py, which reused db/train.score) plus the partner's daily accuracy and the
// period's total bias (db/train.score_recent). Pure: no database, no clock.
import type { AccuracyDay, AccuracyMetrics, AccuracySource } from '#shared/types/api'

export const HOURS_PER_DAY = 24

// One day: the 24 predicted and the 24 actual hourly counts (hour 0..23).
export interface DayInput {
  date: string
  predicted: readonly number[]
  actual: readonly number[]
  source: AccuracySource
  heldOut: boolean
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)
const mean = (values: readonly number[]): number => sum(values) / values.length

function hourlyErrors(day: DayInput): number[] {
  if (day.predicted.length !== HOURS_PER_DAY || day.actual.length !== HOURS_PER_DAY) {
    throw new RangeError(`day ${day.date} needs ${HOURS_PER_DAY} predicted and actual hours`)
  }
  return day.predicted.map((p, hour) => p - (day.actual[hour] ?? 0))
}

export function scoreDay(day: DayInput): AccuracyDay {
  const errors = hourlyErrors(day)
  const actual = sum(day.actual)
  const predicted = sum(day.predicted)
  const error = predicted - actual
  return {
    date: day.date,
    actual_calls: actual,
    predicted_calls: predicted,
    error_calls: error,
    abs_pct_error: actual > 0 ? (Math.abs(error) / actual) * 100 : null,
    hourly_mae: mean(errors.map(Math.abs)),
    source: day.source,
    held_out: day.heldOut,
  }
}

// Over the held-out days only: a day the model was trained on measures nothing.
// null when there is no such day.
export function scorePeriod(days: readonly DayInput[]): AccuracyMetrics | null {
  const scored = days.filter((day) => day.heldOut)
  if (!scored.length) return null
  const errors = scored.flatMap(hourlyErrors)
  const totals = scored.map((day) => ({ actual: sum(day.actual), predicted: sum(day.predicted) }))
  const actual = sum(totals.map((t) => t.actual))
  const predicted = sum(totals.map((t) => t.predicted))
  // The partner's figure is on daily totals, so a busy and a quiet day each count once.
  // A day without calls has no percentage error and is left out of it.
  const dailyApe = totals
    .filter((t) => t.actual > 0)
    .map((t) => Math.abs(t.predicted - t.actual) / t.actual)
  return {
    days: scored.length,
    hours: errors.length,
    actual_calls: actual,
    predicted_calls: predicted,
    hourly_mae: mean(errors.map(Math.abs)),
    hourly_rmse: Math.sqrt(mean(errors.map((e) => e * e))),
    daily_total_mae: mean(totals.map((t) => Math.abs(t.predicted - t.actual))),
    signed_bias: mean(errors),
    daily_accuracy_pct: dailyApe.length ? 100 - mean(dailyApe) * 100 : null,
    total_bias_pct: actual > 0 ? ((predicted - actual) / actual) * 100 : null,
  }
}
