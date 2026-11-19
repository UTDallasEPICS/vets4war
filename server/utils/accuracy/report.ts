// GET /api/admin/accuracy: what the forecast said against the calls that came, per day,
// over a period. The rebuild's version of the old db/monitor.py:
// - a day is compared with the forecast kept when its calls were imported (snapshot),
//   else with the forecast in use now (replay);
// - like monitor.py, only days the predicting model was NOT trained on count in the
//   numbers ("held out"); the others are listed and marked;
// - only days with stored calls are compared. Imports bring whole days, so an hour
//   without calls on such a day is a real zero; a day without calls is never assumed
//   to be one.
// Everything is read in ONE transaction, so a retrain committing meanwhile cannot mix
// two forecasts into one answer.
import { and, between, eq, gte, lt, sql } from 'drizzle-orm'
import { addDays, daysBetween, isIsoDate } from '#shared/utils/dates'
import type { AccuracyResponse, AccuracyStatus } from '#shared/types/api'
import {
  calls,
  forecastHours,
  forecastSnapshots,
  forecastState,
  modelArtifacts,
} from '../../db/schema'
import type { AppDb } from '../db'
import { apiError, validationError, type Issue } from '../http'
import { HOURS_PER_DAY, scoreDay, scorePeriod, type DayInput } from './metrics'

// Two weeks: the cadence the old monitor was scheduled at.
export const DEFAULT_PERIOD_DAYS = 14
export const MAX_PERIOD_DAYS = 366

export interface AccuracyQuery {
  start?: string
  end?: string
}

interface Period {
  start: string
  end: string
}

interface HourValue {
  date: string
  hour: number
  value: number
}

function single(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value
}

export function parseAccuracyQuery(query: Record<string, unknown>): AccuracyQuery {
  const issues: Issue[] = []
  const read = (name: 'start' | 'end'): string | undefined => {
    const raw = single(query[name])
    if (raw === undefined) return undefined
    if (typeof raw === 'string' && isIsoDate(raw)) return raw
    issues.push({ path: name, message: 'must be a real calendar date in the form YYYY-MM-DD' })
    return undefined
  }
  const parsed = { start: read('start'), end: read('end') }
  if (issues.length) throw validationError(issues)
  return parsed
}

// A missing end is two weeks after the start; a missing start two weeks before the end;
// neither: the two weeks ending on the newest stored call day (null when there is none).
function resolvePeriod(query: AccuracyQuery, lastCallDay: string | null): Period | null {
  const back = DEFAULT_PERIOD_DAYS - 1
  const end = query.end ?? (query.start ? addDays(query.start, back) : lastCallDay)
  if (!end) return null
  const start = query.start ?? addDays(end, -back)
  if (end < start) throw apiError(400, 'end_before_start', `end ${end} is before start ${start}`)
  const span = daysBetween(start, end) + 1
  if (span > MAX_PERIOD_DAYS) {
    throw apiError(400, 'range_too_long', `range is ${span} days; maximum is ${MAX_PERIOD_DAYS}`)
  }
  return { start, end }
}

// date -> 24 hourly values; a date with a missing hour maps to null (not usable).
function byDay(rows: readonly HourValue[], fill?: number): Map<string, number[] | null> {
  const days = new Map<string, (number | undefined)[]>()
  for (const row of rows) {
    if (row.hour < 0 || row.hour >= HOURS_PER_DAY) continue
    const hours = days.get(row.date) ?? new Array<number | undefined>(HOURS_PER_DAY).fill(fill)
    hours[row.hour] = row.value
    days.set(row.date, hours)
  }
  return new Map(
    [...days].map(([date, hours]) => [
      date,
      hours.every((v) => v !== undefined) ? (hours as number[]) : null,
    ])
  )
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function describe(days: readonly DayInput[], unmatched: number, trainEndDay: string | null) {
  const warnings: string[] = []
  const inSample = days.filter((d) => !d.heldOut).length
  const replayed = days.filter((d) => d.heldOut && d.source === 'replay').length
  if (inSample) {
    warnings.push(
      `${plural(inSample, 'day')} ${inSample === 1 ? 'is' : 'are'} in the training data of the ` +
        `model in use (calls through ${trainEndDay}) and no forecast was kept from before ` +
        `their calls were imported. They are shown but left out of the numbers.`
    )
  }
  if (replayed) {
    warnings.push(
      `${plural(replayed, 'day')} ${replayed === 1 ? 'is' : 'are'} compared with the forecast ` +
        `in use now. The model had not seen ${replayed === 1 ? 'it' : 'them'}, but this may ` +
        `not be the forecast that was served before the calls came in.`
    )
  }
  if (unmatched) {
    warnings.push(
      `${plural(unmatched, 'day')} with calls ${unmatched === 1 ? 'has' : 'have'} no ` +
        `forecast to compare with.`
    )
  }
  return warnings
}

function statusOf(actualDays: number, days: readonly DayInput[], scored: boolean): AccuracyStatus {
  if (!actualDays) return 'no_data'
  if (!days.length) return 'no_forecast'
  return scored ? 'success' : 'not_held_out'
}

export function readAccuracy(db: AppDb, query: AccuracyQuery): AccuracyResponse {
  return db.transaction((tx) => {
    const range = tx
      .select({
        first: sql<string | null>`substr(min(${calls.startTs}), 1, 10)`,
        last: sql<string | null>`substr(max(${calls.startTs}), 1, 10)`,
      })
      .from(calls)
      .get()
    const callsRange =
      range?.first && range.last ? { first_day: range.first, last_day: range.last } : null
    const state = tx.select().from(forecastState).where(eq(forecastState.id, 1)).get()
    const model = state
      ? tx
          .select({ id: modelArtifacts.id, trainEnd: modelArtifacts.trainEnd })
          .from(modelArtifacts)
          .where(eq(modelArtifacts.id, state.modelId))
          .get()
      : undefined
    const period = resolvePeriod(query, callsRange?.last_day ?? null)
    const answer = {
      period,
      calls_range: callsRange,
      model: model ? { id: model.id, train_end: model.trainEnd } : null,
    }
    if (!period) {
      return { ...answer, status: 'no_data', days: [], metrics: null, warnings: [] }
    }

    const day = sql<string>`substr(${calls.startTs}, 1, 10)`
    const hour = sql<number>`cast(substr(${calls.startTs}, 12, 2) as integer)`
    const actual = byDay(
      tx
        .select({ date: day, hour, value: sql<number>`count(*)` })
        .from(calls)
        .where(and(gte(calls.startTs, period.start), lt(calls.startTs, addDays(period.end, 1))))
        .groupBy(day, hour)
        .all(),
      0
    )
    const kept = byDay(
      tx
        .select({
          date: forecastSnapshots.date,
          hour: forecastSnapshots.hour,
          value: forecastSnapshots.predictedCalls,
        })
        .from(forecastSnapshots)
        .where(between(forecastSnapshots.date, period.start, period.end))
        .all()
    )
    const served = state
      ? byDay(
          tx
            .select({
              date: forecastHours.date,
              hour: forecastHours.hour,
              value: forecastHours.predictedCalls,
            })
            .from(forecastHours)
            .where(between(forecastHours.date, period.start, period.end))
            .all()
        )
      : new Map<string, number[] | null>()

    // A model trained through 2026-11-15T23:00 has seen all of 2026-11-15.
    const trainEndDay = model?.trainEnd.slice(0, 10) ?? null
    const days: DayInput[] = []
    let unmatched = 0
    for (const [date, hours] of [...actual].sort(([a], [b]) => a.localeCompare(b))) {
      const counts = hours ?? new Array<number>(HOURS_PER_DAY).fill(0)
      const snapshot = kept.get(date)
      const replay = served.get(date)
      if (snapshot) {
        days.push({ date, predicted: snapshot, actual: counts, source: 'snapshot', heldOut: true })
      } else if (replay) {
        const heldOut = trainEndDay !== null && date > trainEndDay
        days.push({ date, predicted: replay, actual: counts, source: 'replay', heldOut })
      } else {
        unmatched += 1
      }
    }
    const metrics = scorePeriod(days)
    return {
      ...answer,
      status: statusOf(actual.size, days, metrics !== null),
      days: days.map(scoreDay),
      metrics,
      warnings: describe(days, unmatched, trainEndDay),
    }
  })
}
