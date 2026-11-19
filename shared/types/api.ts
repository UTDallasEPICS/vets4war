// Request and response types of the HTTP API (PLAN.md section 8). Field names are
// snake_case on the wire, as in final-main. Types only: no runtime code in this file,
// because server/db/schema.ts imports it from places that run without Nuxt.

// 8.1 Errors

export interface ApiErrorBody {
  statusCode: number
  statusMessage: string // ASCII reason phrase, e.g. 'Bad Request'
  message: string // the sentence a person reads
  data?: { code: string; [extra: string]: unknown }
}

// 8.2 Forecast routes

export type QueueModel = 'erlang_a' | 'erlang_c'
export type Recency = 'equal' | 'weighted' | 'recent'
export type ShiftName = 'Overnight' | 'Day' | 'Evening'
export type Verdict = 'understaffed' | 'on target' | 'overstaffed' | 'exceeds capacity'

export interface DataSource {
  kind: 'partner' | 'synthetic' | 'unlabeled'
  label: string // 'Partner data' | 'Synthetic data' | 'Data source not set (V4W_DATA_SOURCE)'
  start: string // forecast_state.data_start
  end: string // forecast_state.data_end
}
export type PatienceSource =
  { kind: 'estimated'; n_abandoned: number; n_calls: number } | { kind: 'override' }
export interface ForecastParams {
  start: string
  end: string
  efficiency: number
  target_pct: number
  target_sec: number
  queue_model: QueueModel
  patience_sec: number | null // null under erlang_c
  patience_source: PatienceSource | null // null under erlang_c
  recency: Recency
  include_holidays: boolean
}
export interface HolidayCoverage {
  last_known_holiday: string
  covered: boolean
  message: string | null
}
export interface HourRow {
  date: string
  hour: number
  predicted_calls: number
  predicted_real_calls: number
  aht_sec: number
  load_erlangs: number
  agents_required: number
  staff_to_schedule: number | null
  effective_agents: number | null
  service_level_delivered: number | null
  over_cap: boolean | null
  implausible: boolean
  reason: string | null
  expected_talk_sec: number
  expected_talk: string
  abandon_share: number | null
}
export interface ShiftRollup {
  predicted_calls: number // rounded to 2 decimals
  agents_required: number
  staff_needed: number | null
  capped: boolean | null
  service_level_delivered: number | null
  abandon_share: number | null
}
export interface StaffingDay {
  date: string
  predicted_calls: number
  shifts: Record<ShiftName, ShiftRollup | null>
}
export interface ForecastDay extends StaffingDay {
  is_weekend: boolean
  holiday: string | null
  expected_talk_sec: number
  expected_talk: string
}
export interface WindowSummary {
  start: string
  end: string
  expected_calls: number
  expected_talk_sec: number
  expected_talk: string
  mean_aht_sec: number | null
  expected_abandoned_calls: number | null
  abandon_share: number | null
  expected_abandoned_one_fewer: number | null
  recency: Recency
  recency_effect_pct: number
  caveat: string
}
export interface QuickHangups {
  threshold_sec: number
  window_days: number
  first_day: string
  last_day: string
  n_calls: number
  n_abandoned: number
  n_quick: number
  quick_share_of_abandoned: number | null
  quick_share_of_calls: number | null
}
export interface ForecastResponse {
  params: ForecastParams
  data_source: DataSource
  holiday_coverage: HolidayCoverage
  hours: HourRow[]
  days: ForecastDay[]
  window: WindowSummary
  quick_hangups: QuickHangups
}
export interface StaffingResponse {
  params: ForecastParams
  data_source: DataSource
  holiday_coverage: HolidayCoverage
  days: StaffingDay[]
}
export interface PlannedItem {
  date: string
  shift: ShiftName
  planned: number // integer 0..1000
}
export interface PlannedRequest {
  start: string // required here
  end: string // required here
  efficiency?: number
  target_pct?: number
  target_sec?: number
  queue_model?: QueueModel
  patience_sec?: number | null
  recency?: Recency
  include_holidays?: boolean
  planned: PlannedItem[] // at most 366 * 3 items
}
export interface PlannedShiftResult {
  date: string
  shift: ShiftName
  planned: number
  recommended: number
  delta: number
  cap: number
  verdict: Verdict
  effective_agents: number
  service_level_at_planned: number
  abandon_share_at_planned: number | null
}
export interface PlannedResponse {
  params: ForecastParams
  data_source: DataSource
  shifts: PlannedShiftResult[]
}

// null when the backtest could not measure it (Python stores NaN as null).
export interface GateMetrics {
  daily_mape_1_14: number | null
  daily_mape_15_28: number | null
  hourly_mae_1_14: number | null
  block_wape_1_14: number | null
  week_acc_mean: number | null
  week_acc_std: number | null
  week_acc_min: number | null
  week_total_ape: number | null
}
export interface GateResult {
  origins: number
  first_origin: string
  last_origin: string
  model: GateMetrics
  naive: GateMetrics
  passed: boolean
}
// What models/metadata.json held; written by Python.
export interface ModelMetadata {
  created_at_utc: string
  target: string
  train_start: string
  train_end: string
  train_rows: number
  features: string[]
  lgbm_params: Record<string, unknown>
  num_boost_rounds: number
  config: { label: string }
  procedure: Record<string, unknown>
  calibration: {
    level: number
    level_damping: number
    dow: number[]
    hour: number[]
    shape: number[][]
  }
  level_factor: number
  data_sources: Record<string, unknown>[]
  gate: GateResult
  model_sha256: string
}
export type ModelResponse = ModelMetadata & { data_source: DataSource }

export interface StatusResponse {
  viewer: { email: string; name: string; role: 'viewer' | 'admin' }
  data_source: { kind: DataSource['kind']; label: string }
  forecast: null | {
    run_id: number
    generated_at: string // ISO 8601 UTC
    horizon_start: string
    horizon_end: string
    data_start: string
    data_end: string
    calls_count: number
    stale: boolean // data_state.calls_revision != forecast_state.calls_revision
  }
  model: null | {
    id: number
    created_at: string
    train_start: string
    train_end: string
    train_rows: number
    model_sha256: string
    label: string
  }
  run: null | RunSummary // the queued/running run if any, else the latest finished one
}

// 8.3 Runs

export type RunTrigger = 'import' | 'schedule' | 'manual' | 'startup' | 'cli'
export type RunMode = 'full' | 'forecast-only'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'rejected' | 'failed' | 'interrupted'
export interface RunSummary {
  id: number
  trigger: RunTrigger
  mode: RunMode
  status: RunStatus
  requested_by: string | null
  upload_id: number | null
  created_at: string // ISO 8601 UTC
  started_at: string | null // ISO 8601 UTC
  finished_at: string | null // ISO 8601 UTC
  trained: boolean | null
  gate_passed: boolean | null
  forecast_written: boolean | null
  model_id: number | null
  calls_count: number | null
  data_start: string | null
  data_end: string | null
  horizon_start: string | null
  horizon_end: string | null
  message: string | null
}
export interface RunDetail extends RunSummary {
  gate: GateResult | null
  log_tail: string | null
  exit_code: number | null
}

// 8.4 Uploads

export type UploadStatus =
  'parsing' | 'ready' | 'invalid' | 'importing' | 'imported' | 'discarded' | 'failed'
export type DayStatus = 'new' | 'identical' | 'conflict'
export interface DayPlan {
  day: string
  rows: number
  existing_rows: number
  status: DayStatus
}
export interface UploadIssue {
  code: string
  message: string
}
export interface UploadReport {
  ok: boolean // false when file_errors is not empty
  nothing_to_import: boolean // ok and every day identical
  summary: {
    total_rows: number
    first_day: string | null
    last_day: string | null
    days: number
    new_days: number
    identical_days: number
    conflict_days: number
  }
  days: DayPlan[] // oldest first, every day of the file
  days_without_calls: string[] // dates between first and last day with no call in the file
  file_errors: UploadIssue[]
  warnings: string[]
}
export interface ImportResult {
  inserted_rows: number
  deleted_rows: number
  added_days: string[]
  replaced_days: string[]
  skipped_days: string[]
  calls_revision: number
}
export interface UploadSummary {
  id: number
  source: 'upload' | 'postgres-copy'
  status: UploadStatus
  filename: string
  file_bytes: number
  uploaded_by: string
  created_at: string
  parsed_at: string | null
  imported_by: string | null
  imported_at: string | null
  total_rows: number | null
  first_day: string | null
  last_day: string | null
  new_days: number | null
  identical_days: number | null
  conflict_days: number | null
  run_id: number | null
  error: string | null
}
export interface UploadDetail extends UploadSummary {
  report: UploadReport | null
  result: ImportResult | null
}
export interface ImportRequest {
  total_rows: number
  replace_days: string[]
}

// 8.5 People

export interface PersonRow {
  id: string
  email: string
  name: string
  role: 'viewer' | 'admin'
  email_verified: boolean
  created_at: string
}
