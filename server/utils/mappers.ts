// Table rows -> the API shapes of shared/types/api.ts (snake_case on the wire). Every
// route uses these instead of writing its own, so they all answer the same way.
import type { forecastRuns, uploads, user } from '../db/schema'
import type {
  PersonRow,
  RunDetail,
  RunSummary,
  UploadDetail,
  UploadSummary,
} from '../../shared/types/api'

type RunRow = typeof forecastRuns.$inferSelect
type UploadRow = typeof uploads.$inferSelect
type UserRow = typeof user.$inferSelect

// ISO 8601 in UTC ('2026-11-19T12:00:00.000Z').
export function isoUtc(date: Date): string
export function isoUtc(date: Date | null): string | null
export function isoUtc(date: Date | null): string | null {
  return date ? date.toISOString() : null
}

export function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    mode: row.mode,
    status: row.status,
    requested_by: row.requestedByLabel,
    upload_id: row.uploadId,
    created_at: isoUtc(row.createdAt),
    started_at: isoUtc(row.startedAt),
    finished_at: isoUtc(row.finishedAt),
    trained: row.trained,
    gate_passed: row.gatePassed,
    forecast_written: row.forecastWritten,
    model_id: row.modelId,
    calls_count: row.callsCount,
    data_start: row.dataStart,
    data_end: row.dataEnd,
    horizon_start: row.horizonStart,
    horizon_end: row.horizonEnd,
    message: row.message,
  }
}

export function toRunDetail(row: RunRow): RunDetail {
  return {
    ...toRunSummary(row),
    gate: row.gate,
    log_tail: row.logTail,
    exit_code: row.exitCode,
  }
}

export function toUploadSummary(row: UploadRow): UploadSummary {
  const summary = row.report?.summary ?? null
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    filename: row.filename,
    file_bytes: row.fileBytes,
    uploaded_by: row.uploadedByLabel,
    created_at: isoUtc(row.createdAt),
    parsed_at: isoUtc(row.parsedAt),
    imported_by: row.importedByLabel,
    imported_at: isoUtc(row.importedAt),
    total_rows: row.totalRows,
    first_day: row.firstDay,
    last_day: row.lastDay,
    new_days: summary ? summary.new_days : null,
    identical_days: summary ? summary.identical_days : null,
    conflict_days: summary ? summary.conflict_days : null,
    run_id: row.runId,
    error: row.error,
  }
}

export function toUploadDetail(row: UploadRow): UploadDetail {
  return {
    ...toUploadSummary(row),
    report: row.report,
    result: row.result,
  }
}

export function toPersonRow(row: UserRow): PersonRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    email_verified: row.emailVerified,
    created_at: isoUtc(row.createdAt),
  }
}
