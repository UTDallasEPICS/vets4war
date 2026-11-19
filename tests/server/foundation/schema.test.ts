// The committed migrations produce exactly the tables of PLAN.md section 6. Python reads
// and writes these by their SQL names, so a renamed or missing column is a contract break.
import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, createTestUser } from '../../helpers/db'
import * as schema from '../../../server/db/schema'

const EXPECTED_COLUMNS: Record<string, string[]> = {
  user: ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt', 'role'],
  session: [
    'id',
    'expiresAt',
    'token',
    'createdAt',
    'updatedAt',
    'ipAddress',
    'userAgent',
    'userId',
  ],
  account: [
    'id',
    'accountId',
    'providerId',
    'userId',
    'accessToken',
    'refreshToken',
    'idToken',
    'accessTokenExpiresAt',
    'refreshTokenExpiresAt',
    'scope',
    'password',
    'createdAt',
    'updatedAt',
  ],
  verification: ['id', 'identifier', 'value', 'expiresAt', 'createdAt', 'updatedAt'],
  uploads: [
    'id',
    'source',
    'status',
    'filename',
    'file_sha256',
    'file_bytes',
    'uploaded_by',
    'uploaded_by_label',
    'created_at',
    'parsed_at',
    'imported_at',
    'imported_by_label',
    'total_rows',
    'first_day',
    'last_day',
    'report_json',
    'result_json',
    'error',
    'run_id',
  ],
  upload_rows: [
    'id',
    'upload_id',
    'start_ts',
    'in_queue_sec',
    'agent_sec',
    'abandon_sec',
    'routing_sec',
    'abandoned',
  ],
  calls: [
    'id',
    'start_ts',
    'in_queue_sec',
    'agent_sec',
    'abandon_sec',
    'routing_sec',
    'abandoned',
    'upload_id',
  ],
  replaced_calls: [
    'id',
    'replaced_by_upload_id',
    'original_upload_id',
    'start_ts',
    'in_queue_sec',
    'agent_sec',
    'abandon_sec',
    'routing_sec',
    'abandoned',
  ],
  holidays: ['holiday_date', 'holiday_name'],
  data_state: ['id', 'calls_revision', 'rerun_requested', 'updated_at'],
  forecast_runs: [
    'id',
    'trigger',
    'mode',
    'status',
    'requested_by_label',
    'upload_id',
    'created_at',
    'started_at',
    'finished_at',
    'pid',
    'exit_code',
    'calls_revision',
    'calls_count',
    'data_start',
    'data_end',
    'trained',
    'model_id',
    'gate_passed',
    'gate_json',
    'forecast_written',
    'horizon_start',
    'horizon_end',
    'message',
    'log_tail',
  ],
  model_artifacts: [
    'id',
    'run_id',
    'created_at',
    'model_sha256',
    'model_text',
    'metadata_json',
    'train_start',
    'train_end',
    'train_rows',
  ],
  forecast_state: [
    'id',
    'run_id',
    'model_id',
    'generated_at',
    'calls_revision',
    'calls_count',
    'data_start',
    'data_end',
    'horizon_start',
    'horizon_end',
    'patience_sec',
    'patience_n_abandoned',
    'patience_n_calls',
    'quick_hangups_json',
  ],
  forecast_hours: ['date', 'hour', 'predicted_calls', 'predicted_calls_no_holidays'],
  forecast_cells: ['recency', 'dow', 'hour', 'aht_sec', 'real_share'],
}

const EXPECTED_INDEXES = [
  'uploads_created_idx',
  'uploads_sha_idx',
  'upload_rows_upload_idx',
  'calls_start_ts_idx',
  'replaced_calls_upload_idx',
  'forecast_runs_status_idx',
  'forecast_runs_created_idx',
]

function newUpload(db: ReturnType<typeof createTestDb>['db']) {
  return db
    .insert(schema.uploads)
    .values({
      source: 'upload',
      status: 'ready',
      filename: 'synthetic.xlsx',
      fileSha256: 'a'.repeat(64),
      fileBytes: 10,
      uploadedByLabel: 'cli',
      createdAt: new Date(),
    })
    .returning({ id: schema.uploads.id })
    .get()
}

describe('database schema', () => {
  it('applies every migration to an empty database', () => {
    const { sqlite } = createTestDb()
    const applied = sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as {
      n: number
    }
    expect(applied.n).toBe(2)
  })

  it('has exactly the documented tables and column names', () => {
    const { sqlite } = createTestDb()
    const tables = (
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name"
        )
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(tables).toEqual(Object.keys(EXPECTED_COLUMNS).sort())

    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      const actual = (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map(
        (c) => c.name
      )
      expect(actual, table).toEqual(columns)
    }
  })

  it('has the documented indexes', () => {
    const { sqlite } = createTestDb()
    const indexes = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    for (const name of EXPECTED_INDEXES) expect(indexes).toContain(name)
  })

  it('gives a new user the viewer role', () => {
    const { db, sqlite } = createTestDb()
    sqlite
      .prepare(
        "INSERT INTO user (id, name, email, createdAt, updatedAt) VALUES ('u1', 'A', 'a@example.org', 0, 0)"
      )
      .run()
    const row = db.select().from(schema.user).where(eq(schema.user.id, 'u1')).get()
    expect(row?.role).toBe('viewer')
    expect(createTestUser(db, { email: 'b@example.org' }).role).toBe('viewer')
  })

  it('deletes staged rows with their upload', () => {
    const { db } = createTestDb()
    const upload = newUpload(db)
    db.insert(schema.uploadRows)
      .values({
        uploadId: upload.id,
        startTs: '2026-01-01T00:13:33',
        inQueueSec: 1,
        agentSec: 2,
        abandonSec: 0,
        routingSec: 0,
        abandoned: false,
      })
      .run()
    db.delete(schema.uploads).where(eq(schema.uploads.id, upload.id)).run()
    expect(db.select().from(schema.uploadRows).all()).toEqual([])
  })

  it('refuses a second forecast_hours row for the same date and hour', () => {
    const { db } = createTestDb()
    const row = { date: '2026-11-19', hour: 9, predictedCalls: 8.5, predictedCallsNoHolidays: 8.5 }
    db.insert(schema.forecastHours).values(row).run()
    expect(() => db.insert(schema.forecastHours).values(row).run()).toThrow(/UNIQUE constraint/)
  })

  it('round-trips JSON columns and stores timestamps as unix seconds', () => {
    const { db, sqlite } = createTestDb()
    const upload = newUpload(db)
    const created = new Date('2026-11-19T12:00:00Z')
    db.update(schema.uploads)
      .set({
        createdAt: created,
        result: {
          inserted_rows: 1,
          deleted_rows: 0,
          added_days: ['2026-01-01'],
          replaced_days: [],
          skipped_days: [],
          calls_revision: 1,
        },
      })
      .where(eq(schema.uploads.id, upload.id))
      .run()
    const raw = sqlite
      .prepare('SELECT created_at, result_json FROM uploads WHERE id = ?')
      .get(upload.id) as { created_at: number; result_json: string }
    expect(raw.created_at).toBe(created.getTime() / 1000)
    expect(JSON.parse(raw.result_json).added_days).toEqual(['2026-01-01'])
  })
})
