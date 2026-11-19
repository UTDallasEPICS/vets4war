import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '../../../server/db/schema'
import {
  isoUtc,
  toPersonRow,
  toRunDetail,
  toRunSummary,
  toUploadDetail,
  toUploadSummary,
} from '../../../server/utils/mappers'
import type { UploadReport } from '../../../shared/types/api'
import { createTestDb, createTestUser } from '../../helpers/db'

const T0 = new Date('2026-11-19T12:00:00Z')
const T1 = new Date('2026-11-19T12:05:30Z')

const REPORT: UploadReport = {
  ok: true,
  nothing_to_import: false,
  summary: {
    total_rows: 365,
    first_day: '2026-11-16',
    last_day: '2026-11-17',
    days: 2,
    new_days: 1,
    identical_days: 0,
    conflict_days: 1,
  },
  days: [],
  days_without_calls: [],
  file_errors: [],
  warnings: [],
}

describe('mappers', () => {
  it('writes timestamps as ISO 8601 UTC', () => {
    expect(isoUtc(T0)).toBe('2026-11-19T12:00:00.000Z')
    expect(isoUtc(null)).toBeNull()
  })

  it('maps a run row read back from the database', () => {
    const { db } = createTestDb()
    const id = db
      .insert(schema.forecastRuns)
      .values({
        trigger: 'import',
        mode: 'full',
        status: 'rejected',
        requestedByLabel: 'admin@example.org',
        uploadId: 4,
        createdAt: T0,
        startedAt: T1,
        exitCode: 3,
        trained: false,
        gatePassed: false,
        forecastWritten: true,
        logTail: 'gate table',
        message: 'The previous model was kept.',
      })
      .returning({ id: schema.forecastRuns.id })
      .get().id
    const row = db.select().from(schema.forecastRuns).where(eq(schema.forecastRuns.id, id)).get()!
    expect(toRunSummary(row)).toEqual({
      id,
      trigger: 'import',
      mode: 'full',
      status: 'rejected',
      requested_by: 'admin@example.org',
      upload_id: 4,
      created_at: '2026-11-19T12:00:00.000Z',
      started_at: '2026-11-19T12:05:30.000Z',
      finished_at: null,
      trained: false,
      gate_passed: false,
      forecast_written: true,
      model_id: null,
      calls_count: null,
      data_start: null,
      data_end: null,
      horizon_start: null,
      horizon_end: null,
      message: 'The previous model was kept.',
    })
    expect(toRunDetail(row)).toMatchObject({ gate: null, log_tail: 'gate table', exit_code: 3 })
  })

  it('maps an upload, taking the day counts from its report', () => {
    const { db } = createTestDb()
    const id = db
      .insert(schema.uploads)
      .values({
        source: 'upload',
        status: 'ready',
        filename: 'week.xlsx',
        fileSha256: 'b'.repeat(64),
        fileBytes: 2048,
        uploadedByLabel: 'admin@example.org',
        createdAt: T0,
        parsedAt: T1,
        totalRows: 365,
        firstDay: '2026-11-16',
        lastDay: '2026-11-17',
        report: REPORT,
      })
      .returning({ id: schema.uploads.id })
      .get().id
    const row = db.select().from(schema.uploads).where(eq(schema.uploads.id, id)).get()!
    expect(toUploadSummary(row)).toEqual({
      id,
      source: 'upload',
      status: 'ready',
      filename: 'week.xlsx',
      file_bytes: 2048,
      uploaded_by: 'admin@example.org',
      created_at: '2026-11-19T12:00:00.000Z',
      parsed_at: '2026-11-19T12:05:30.000Z',
      imported_by: null,
      imported_at: null,
      total_rows: 365,
      first_day: '2026-11-16',
      last_day: '2026-11-17',
      new_days: 1,
      identical_days: 0,
      conflict_days: 1,
      run_id: null,
      error: null,
    })
    expect(toUploadDetail(row)).toMatchObject({ report: REPORT, result: null })
  })

  it('leaves the day counts null without a report', () => {
    const { db } = createTestDb()
    const row = db
      .insert(schema.uploads)
      .values({
        source: 'postgres-copy',
        status: 'parsing',
        filename: 'postgres',
        fileSha256: 'c'.repeat(64),
        fileBytes: 0,
        uploadedByLabel: 'cli',
        createdAt: T0,
      })
      .returning()
      .get()
    expect(toUploadSummary(row)).toMatchObject({
      new_days: null,
      identical_days: null,
      conflict_days: null,
    })
  })

  it('maps a person', () => {
    const { db } = createTestDb()
    const { id } = createTestUser(db, { email: 'p@example.org', role: 'admin', name: 'Pat' })
    const row = db.select().from(schema.user).where(eq(schema.user.id, id)).get()!
    const person = toPersonRow(row)
    expect(person).toEqual({
      id,
      email: 'p@example.org',
      name: 'Pat',
      role: 'admin',
      email_verified: false,
      created_at: isoUtc(row.createdAt),
    })
    expect(person.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/)
  })
})
