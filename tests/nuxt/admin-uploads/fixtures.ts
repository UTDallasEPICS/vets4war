// SYNTHETIC upload and run answers for the uploads panel's component tests.
import type { DayPlan, RunSummary, UploadDetail } from '#shared/types/api'

export function upload(overrides: Partial<UploadDetail> = {}): UploadDetail {
  return {
    id: 5,
    source: 'upload',
    status: 'ready',
    filename: 'SYNTHETIC calls.xlsx',
    file_bytes: 1000,
    uploaded_by: 'admin@example.org',
    created_at: '2026-11-19T04:00:00.000Z',
    parsed_at: '2026-11-19T04:00:05.000Z',
    imported_by: null,
    imported_at: null,
    total_rows: 0,
    first_day: null,
    last_day: null,
    new_days: null,
    identical_days: null,
    conflict_days: null,
    run_id: null,
    error: null,
    report: null,
    result: null,
    ...overrides,
  }
}

export function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 3,
    trigger: 'import',
    mode: 'full',
    status: 'running',
    requested_by: 'admin@example.org',
    upload_id: 4,
    created_at: '2026-11-19T04:00:00.000Z',
    started_at: '2026-11-19T04:00:01.000Z',
    finished_at: null,
    trained: null,
    gate_passed: null,
    forecast_written: null,
    model_id: null,
    calls_count: null,
    data_start: null,
    data_end: null,
    horizon_start: null,
    horizon_end: null,
    message: null,
    ...overrides,
  }
}

// `count` consecutive days from `first`, each with `rows` calls and the given status.
export function days(
  first: string,
  count: number,
  status: DayPlan['status'],
  rows = 180
): DayPlan[] {
  const out: DayPlan[] = []
  const date = new Date(`${first}T00:00:00Z`)
  for (let i = 0; i < count; i++) {
    out.push({
      day: date.toISOString().slice(0, 10),
      rows,
      existing_rows: status === 'new' ? 0 : rows,
      status,
    })
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return out
}
