// Fills the forecast tables of a test database with a small, hand-traceable forecast:
// what the Python retrain script writes (PLAN.md section 6), with numbers simple enough
// to check by hand.
import { H3Error } from 'h3'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import { dateRange } from '../../../shared/utils/dates'
import type { ModelMetadata, QuickHangups, Recency } from '../../../shared/types/api'

export const RUNTIME = { dataSourceKind: 'synthetic' as const, today: '2026-11-19' }

export const QUICK: QuickHangups = {
  threshold_sec: 10,
  window_days: 90,
  first_day: '2026-08-18',
  last_day: '2026-11-15',
  n_calls: 1000,
  n_abandoned: 150,
  n_quick: 60,
  quick_share_of_abandoned: 0.4,
  quick_share_of_calls: 0.06,
}

export const METADATA = {
  created_at_utc: '2026-11-19T00:40:14+00:00',
  target: 'offered',
  train_start: '2021-01-01T00:00:00',
  train_end: '2026-11-15T23:00:00',
  train_rows: 51480,
  features: ['dow', 'hour'],
  lgbm_params: { objective: 'poisson' },
  num_boost_rounds: 500,
  config: { label: 'test model' },
  procedure: {},
  calibration: { level: 1, level_damping: 0.5, dow: [], hour: [], shape: [] },
  level_factor: 1,
  data_sources: [],
  gate: {
    origins: 26,
    first_origin: '2026-05-01',
    last_origin: '2026-10-25',
    model: {
      daily_mape_1_14: 0.1,
      daily_mape_15_28: 0.1,
      hourly_mae_1_14: 1,
      block_wape_1_14: 0.1,
      week_acc_mean: 0.9,
      week_acc_std: 0.01,
      week_acc_min: 0.88,
      week_total_ape: 0.02,
    },
    naive: {
      daily_mape_1_14: 0.2,
      daily_mape_15_28: 0.2,
      hourly_mae_1_14: 2,
      block_wape_1_14: 0.2,
      week_acc_mean: 0.8,
      week_acc_std: 0.02,
      week_acc_min: 0.75,
      week_total_ape: 0.05,
    },
    passed: true,
  },
  model_sha256: 'ab'.repeat(32),
} satisfies ModelMetadata

// Handle time differs per recency so a test can tell which cells were read.
export const AHT: Record<Recency, number> = { equal: 600, weighted: 660, recent: 720 }
export const REAL_SHARE = 0.7
export const PATIENCE = { sec: 250, nAbandoned: 150, nCalls: 1000 }

export interface SeedOptions {
  horizonStart?: string
  horizonEnd?: string
  calls?: (date: string, hour: number) => number
  callsNoHolidays?: (date: string, hour: number) => number
  holidays?: [string, string][]
  skipHours?: boolean
  skipCells?: boolean
}

// 10 calls an hour (2 more on a holiday-on forecast at hour 12), constant cells.
export function seedForecast(db: AppDb, options: SeedOptions = {}) {
  const horizonStart = options.horizonStart ?? '2026-11-01'
  const horizonEnd = options.horizonEnd ?? '2026-12-31'
  const calls = options.calls ?? ((_d: string, h: number) => (h === 12 ? 12 : 10))
  const noHolidays = options.callsNoHolidays ?? (() => 10)
  const created = new Date('2026-11-19T00:40:14Z')

  const run = db
    .insert(schema.forecastRuns)
    .values({
      trigger: 'cli',
      mode: 'full',
      status: 'succeeded',
      requestedByLabel: 'cli',
      createdAt: created,
      startedAt: created,
      finishedAt: created,
      trained: true,
      gatePassed: true,
      forecastWritten: true,
      callsRevision: 1,
      callsCount: 1000,
      dataStart: '2021-01-01',
      dataEnd: '2026-11-15',
      horizonStart,
      horizonEnd,
      message: 'test run',
    })
    .returning()
    .get()
  const model = db
    .insert(schema.modelArtifacts)
    .values({
      runId: run.id,
      createdAt: created,
      modelSha256: METADATA.model_sha256,
      modelText: 'tree',
      metadata: METADATA,
      trainStart: METADATA.train_start,
      trainEnd: METADATA.train_end,
      trainRows: METADATA.train_rows,
    })
    .returning()
    .get()
  db.insert(schema.forecastState)
    .values({
      id: 1,
      runId: run.id,
      modelId: model.id,
      generatedAt: created,
      callsRevision: 1,
      callsCount: 1000,
      dataStart: '2021-01-01',
      dataEnd: '2026-11-15',
      horizonStart,
      horizonEnd,
      patienceSec: PATIENCE.sec,
      patienceNAbandoned: PATIENCE.nAbandoned,
      patienceNCalls: PATIENCE.nCalls,
      quickHangups: QUICK,
    })
    .run()
  db.insert(schema.dataState)
    .values({ id: 1, callsRevision: 1, rerunRequested: false, updatedAt: created })
    .run()

  if (!options.skipHours) {
    const rows = dateRange(horizonStart, horizonEnd).flatMap((date) =>
      Array.from({ length: 24 }, (_, hour) => ({
        date,
        hour,
        predictedCalls: calls(date, hour),
        predictedCallsNoHolidays: noHolidays(date, hour),
      }))
    )
    for (let i = 0; i < rows.length; i += 500) {
      db.insert(schema.forecastHours)
        .values(rows.slice(i, i + 500))
        .run()
    }
  }
  if (!options.skipCells) {
    const cells = (['equal', 'weighted', 'recent'] as const).flatMap((recency) =>
      Array.from({ length: 7 * 24 }, (_, i) => ({
        recency,
        dow: Math.floor(i / 24) + 1,
        hour: i % 24,
        ahtSec: AHT[recency],
        realShare: REAL_SHARE,
      }))
    )
    db.insert(schema.forecastCells).values(cells).run()
  }
  const holidays = options.holidays ?? [
    ['2026-11-26', 'Thanksgiving'],
    ['2026-12-25', 'Christmas Day'],
    ['2027-12-25', 'Christmas Day'],
  ]
  if (holidays.length) {
    db.insert(schema.holidays)
      .values(holidays.map(([holidayDate, holidayName]) => ({ holidayDate, holidayName })))
      .run()
  }
  return { run, model }
}

// The data every API error carries (PLAN.md section 8.1).
export type ErrorData = { code: string; [extra: string]: unknown }

export interface CaughtError {
  statusCode: number
  statusMessage: string
  message: string
  data: ErrorData
}

// The API error a call throws (fails the test when it throws anything else, or nothing).
export function caught(fn: () => unknown): CaughtError {
  try {
    fn()
  } catch (error) {
    if (!(error instanceof H3Error)) throw error
    const { statusCode, statusMessage = '', message, data } = error as H3Error<ErrorData>
    if (!data) throw new Error(`the error has no data: ${message}`, { cause: error })
    return { statusCode, statusMessage, message, data }
  }
  throw new Error('expected an H3Error, nothing was thrown')
}

// The API error an async call rejects with.
export async function rejected(fn: () => Promise<unknown>): Promise<CaughtError> {
  let failure: unknown
  try {
    await fn()
  } catch (error) {
    failure = error
  }
  return caught(() => {
    if (failure === undefined) return
    throw failure
  })
}
