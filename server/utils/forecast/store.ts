// Reads what the Python retrain script wrote (PLAN.md section 6). Each function reads
// everything one answer needs inside ONE transaction, so a retrain that commits in
// between can never mix two forecasts in one response.
import { between, desc, eq, inArray, max } from 'drizzle-orm'
import { dateRange } from '#shared/utils/dates'
import { RECENCY_OPTIONS } from '#shared/utils/staffing'
import type { Recency } from '#shared/types/api'
import {
  dataState,
  forecastCells,
  forecastHours,
  forecastRuns,
  forecastState,
  holidays,
  modelArtifacts,
} from '../../db/schema'
import type { AppDb } from '../db'
import { apiError } from '../http'

export type ForecastStateRow = typeof forecastState.$inferSelect
type RunRow = typeof forecastRuns.$inferSelect
export type DataStateRow = typeof dataState.$inferSelect
// The model row without its 1.8 MB model text, which no route returns.
export type ModelRow = Omit<typeof modelArtifacts.$inferSelect, 'modelText'>

export interface StoredHour {
  date: string
  hour: number
  predictedCalls: number
  predictedCallsNoHolidays: number
}

export interface Cell {
  ahtSec: number
  realShare: number
}

// cells[recency][(dow - 1) * 24 + hour], dow ISO 1..7.
export type CellTable = Record<Recency, Cell[]>

export interface ForecastSnapshot {
  state: ForecastStateRow
  hours: StoredHour[] // the requested range, ordered by date, hour; 24 per date
  cells: CellTable
  holidayNames: Map<string, string> // holidays inside the requested range
  lastHoliday: string // newest holiday_date in the table
}

const HOURS_PER_DAY = 24
const DAYS_PER_WEEK = 7
const CELLS_PER_RECENCY = DAYS_PER_WEEK * HOURS_PER_DAY
const NO_FORECAST = 'No forecast yet. An admin needs to load call data and run a retrain.'
const INCOMPLETE = 'The stored forecast is incomplete; run a retrain.'

export function cellIndex(dow: number, hour: number): number {
  return (dow - 1) * HOURS_PER_DAY + hour
}

const modelColumns = {
  id: modelArtifacts.id,
  runId: modelArtifacts.runId,
  createdAt: modelArtifacts.createdAt,
  modelSha256: modelArtifacts.modelSha256,
  metadata: modelArtifacts.metadata,
  trainStart: modelArtifacts.trainStart,
  trainEnd: modelArtifacts.trainEnd,
  trainRows: modelArtifacts.trainRows,
}

function incomplete() {
  return apiError(500, 'internal', INCOMPLETE)
}

function readState(tx: AppDb): ForecastStateRow | undefined {
  return tx.select().from(forecastState).where(eq(forecastState.id, 1)).get()
}

// Every hour of [start, end] with the handle-time cells and the holiday calendar.
// 503 before the first forecast; 400 for dates the forecast does not cover; 500 when
// the stored rows are not whole (a day without 24 hours, a missing cell).
export function readForecastSnapshot(
  db: AppDb,
  range: { start: string; end: string }
): ForecastSnapshot {
  return db.transaction((tx) => {
    const state = readState(tx)
    if (!state) throw apiError(503, 'no_forecast', NO_FORECAST)
    if (range.start < state.horizonStart || range.end > state.horizonEnd) {
      throw apiError(
        400,
        'outside_horizon',
        `The forecast covers ${state.horizonStart} to ${state.horizonEnd}.`,
        { horizon: { start: state.horizonStart, end: state.horizonEnd } }
      )
    }

    const hours = tx
      .select()
      .from(forecastHours)
      .where(between(forecastHours.date, range.start, range.end))
      .orderBy(forecastHours.date, forecastHours.hour)
      .all()
    const dates = dateRange(range.start, range.end)
    if (hours.length !== dates.length * HOURS_PER_DAY) throw incomplete()
    hours.forEach((row, i) => {
      if (row.date !== dates[Math.floor(i / HOURS_PER_DAY)] || row.hour !== i % HOURS_PER_DAY) {
        throw incomplete()
      }
    })

    const cells = Object.fromEntries(
      RECENCY_OPTIONS.map((r) => [r, new Array<Cell | undefined>(CELLS_PER_RECENCY)])
    ) as Record<Recency, (Cell | undefined)[]>
    for (const row of tx.select().from(forecastCells).all()) {
      if (row.dow < 1 || row.dow > DAYS_PER_WEEK || row.hour < 0 || row.hour >= HOURS_PER_DAY) {
        continue
      }
      cells[row.recency][cellIndex(row.dow, row.hour)] = {
        ahtSec: row.ahtSec,
        realShare: row.realShare,
      }
    }
    for (const recency of RECENCY_OPTIONS) {
      for (let i = 0; i < CELLS_PER_RECENCY; i += 1) {
        if (!cells[recency][i]) throw incomplete()
      }
    }

    const holidayNames = new Map(
      tx
        .select()
        .from(holidays)
        .where(between(holidays.holidayDate, range.start, range.end))
        .all()
        .map((h) => [h.holidayDate, h.holidayName])
    )
    const newest = tx
      .select({ last: max(holidays.holidayDate) })
      .from(holidays)
      .get()
    // Python inserts the official holidays at the start of every run, so an empty
    // table means the stored data did not come from a finished run.
    if (!newest?.last) throw incomplete()

    return {
      state,
      hours,
      cells: cells as CellTable,
      holidayNames,
      lastHoliday: newest.last,
    }
  })
}

export interface ServingModel {
  state: ForecastStateRow
  model: ModelRow
}

// The artifact forecast_state points at, with the state (for the data range), or null.
export function readServingModel(db: AppDb): ServingModel | null {
  return db.transaction((tx) => {
    const state = readState(tx)
    if (!state) return null
    const model = tx
      .select(modelColumns)
      .from(modelArtifacts)
      .where(eq(modelArtifacts.id, state.modelId))
      .get()
    return model ? { state, model } : null
  })
}

export interface StatusSnapshot {
  state: ForecastStateRow | null
  model: ModelRow | null
  dataState: DataStateRow | null
  run: RunRow | null // the queued/running run, else the newest one
}

export function readStatus(db: AppDb): StatusSnapshot {
  return db.transaction((tx) => {
    const state = readState(tx) ?? null
    const model = state
      ? (tx
          .select(modelColumns)
          .from(modelArtifacts)
          .where(eq(modelArtifacts.id, state.modelId))
          .get() ?? null)
      : null
    const data = tx.select().from(dataState).where(eq(dataState.id, 1)).get() ?? null
    const newestFirst = [desc(forecastRuns.createdAt), desc(forecastRuns.id)]
    const active = tx
      .select()
      .from(forecastRuns)
      .where(inArray(forecastRuns.status, ['queued', 'running']))
      .orderBy(...newestFirst)
      .limit(1)
      .get()
    const run = active ?? tx.select().from(forecastRuns).orderBy(...newestFirst).limit(1).get()
    return { state, model, dataState: data, run: run ?? null }
  })
}
