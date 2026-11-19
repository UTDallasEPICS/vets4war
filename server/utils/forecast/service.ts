// The five read routes as functions of the database, so tests run
// them against an in-memory SQLite without a server. Routes under server/api/ only read
// the request and call these.
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type {
  DataSource,
  HourRow,
  PlannedShiftResult,
  ForecastParams,
  ForecastResponse,
  ModelResponse,
  PlannedResponse,
  StaffingResponse,
  StatusResponse,
} from '#shared/types/api'
import { SOURCE_LABELS } from '#shared/utils/constants'
import type { AppDb } from '../db'
import type { Env } from '../env'
import { apiError } from '../http'
import { isoUtc, toRunSummary } from '../mappers'
import {
  equalWeightTalkSec,
  forecastDays,
  holidayCoverage,
  hourRows,
  judgePlanned,
  resolvePatience,
  type RolledDay,
  rollupShifts,
  staffingDays,
  windowSummary,
} from './compute'
import {
  parseForecastQuery,
  parsePlannedBody,
  type ForecastInput,
  type PlannedInput,
} from './params'
import { describeSource } from './source'
import { readForecastSnapshot, readServingModel, readStatus, type ForecastSnapshot } from './store'

export interface ForecastRuntime {
  dataSourceKind: Env['V4W_DATA_SOURCE']
  today: string // YYYY-MM-DD on the line (America/New_York)
}

export interface StatusViewer {
  email: string
  name: string
  role: 'viewer' | 'admin'
}

const NO_MODEL = 'No model yet. An admin needs to load call data and run a retrain.'

function params(
  input: ForecastInput,
  patience: ReturnType<typeof resolvePatience>
): ForecastParams {
  return {
    start: input.start,
    end: input.end,
    efficiency: input.efficiency,
    target_pct: input.targetPct,
    target_sec: input.targetSec,
    queue_model: input.queueModel,
    patience_sec: patience.patienceSec,
    patience_source: patience.source,
    recency: input.recency,
    include_holidays: input.includeHolidays,
  }
}

const HOURS_PER_DAY = 24

// The Erlang chain is synchronous CPU work on the server's one thread (up to tens of
// milliseconds per day of range inside the parameter bounds). It runs one day at a
// time and gives the event loop back between days, so a 366-day request never keeps
// other requests (or the health check) waiting for longer than one day's work.
async function hourRowsByDay(
  snapshot: ForecastSnapshot,
  input: ForecastInput,
  patienceSec: number | null
): Promise<HourRow[]> {
  const rows: HourRow[] = []
  for (let i = 0; i < snapshot.hours.length; i += HOURS_PER_DAY) {
    if (i > 0) await yieldToEventLoop()
    const day = { hours: snapshot.hours.slice(i, i + HOURS_PER_DAY), cells: snapshot.cells }
    rows.push(...hourRows(day, input, patienceSec))
  }
  return rows
}

// Everything the three forecast answers share: snapshot, patience, hours, roll-up.
async function evaluate(db: AppDb, runtime: ForecastRuntime, input: ForecastInput) {
  const snapshot: ForecastSnapshot = readForecastSnapshot(db, input)
  const patience = resolvePatience(input, snapshot.state)
  const hours = await hourRowsByDay(snapshot, input, patience.patienceSec)
  const source: DataSource = describeSource(runtime.dataSourceKind, snapshot.state)
  await yieldToEventLoop()
  const rolled = rollupShifts(hours)
  await yieldToEventLoop()
  return { snapshot, patience, hours, rolled, source }
}

// Each roster item evaluates the Erlang chain over its shift's hours (two Erlang A
// calls per hour), so 1,098 items are about as much work as a long range: judged in
// slices, with the event loop given back between them. The first refusal still wins
// in item order, and efficiency 0 is refused before any item.
const PLANNED_PER_SLICE = 24

async function judgePlannedInSlices(
  hours: HourRow[],
  rolled: RolledDay[],
  input: PlannedInput,
  patienceSec: number | null
): Promise<PlannedShiftResult[]> {
  const results: PlannedShiftResult[] = []
  for (let i = 0; i === 0 || i < input.planned.length; i += PLANNED_PER_SLICE) {
    if (i > 0) await yieldToEventLoop()
    const slice = { ...input, planned: input.planned.slice(i, i + PLANNED_PER_SLICE) }
    results.push(...judgePlanned(hours, rolled, slice, patienceSec))
  }
  return results
}

export async function getForecast(
  db: AppDb,
  runtime: ForecastRuntime,
  query: Record<string, unknown>
): Promise<ForecastResponse> {
  const input = parseForecastQuery(query, runtime.today)
  const { snapshot, patience, hours, rolled, source } = await evaluate(db, runtime, input)
  const days = forecastDays(rolled, hours, snapshot.holidayNames)
  await yieldToEventLoop()
  return {
    params: params(input, patience),
    data_source: source,
    holiday_coverage: holidayCoverage(snapshot.lastHoliday, input.end),
    hours,
    days,
    window: windowSummary(
      hours,
      input,
      patience.patienceSec,
      equalWeightTalkSec(snapshot, input, hours)
    ),
    quick_hangups: snapshot.state.quickHangups,
  }
}

export async function getStaffing(
  db: AppDb,
  runtime: ForecastRuntime,
  query: Record<string, unknown>
): Promise<StaffingResponse> {
  const input = parseForecastQuery(query, runtime.today)
  const { snapshot, patience, rolled, source } = await evaluate(db, runtime, input)
  return {
    params: params(input, patience),
    data_source: source,
    holiday_coverage: holidayCoverage(snapshot.lastHoliday, input.end),
    days: staffingDays(rolled),
  }
}

export async function postPlanned(
  db: AppDb,
  runtime: ForecastRuntime,
  body: unknown
): Promise<PlannedResponse> {
  const input = parsePlannedBody(body)
  const { patience, hours, rolled, source } = await evaluate(db, runtime, input)
  return {
    params: params(input, patience),
    data_source: source,
    shifts: await judgePlannedInSlices(hours, rolled, input, patience.patienceSec),
  }
}

export function getModel(db: AppDb, runtime: ForecastRuntime): ModelResponse {
  const serving = readServingModel(db)
  if (!serving) throw apiError(404, 'not_found', NO_MODEL)
  return {
    ...serving.model.metadata,
    data_source: describeSource(runtime.dataSourceKind, serving.state),
  }
}

export function getStatus(
  db: AppDb,
  runtime: ForecastRuntime,
  user: StatusViewer
): StatusResponse {
  const { state, model, dataState, run } = readStatus(db)
  return {
    viewer: { email: user.email, name: user.name, role: user.role },
    data_source: { kind: runtime.dataSourceKind, label: SOURCE_LABELS[runtime.dataSourceKind] },
    forecast: state
      ? {
          run_id: state.runId,
          generated_at: isoUtc(state.generatedAt),
          horizon_start: state.horizonStart,
          horizon_end: state.horizonEnd,
          data_start: state.dataStart,
          data_end: state.dataEnd,
          calls_count: state.callsCount,
          stale: (dataState?.callsRevision ?? 0) !== state.callsRevision,
        }
      : null,
    model: model
      ? {
          id: model.id,
          created_at: isoUtc(model.createdAt),
          train_start: model.trainStart,
          train_end: model.trainEnd,
          train_rows: model.trainRows,
          model_sha256: model.modelSha256,
          label: model.metadata.config?.label ?? '',
        }
      : null,
    run: run ? toRunSummary(run) : null,
  }
}
