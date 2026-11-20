import { sqliteTable, text, integer, index, real, primaryKey } from 'drizzle-orm/sqlite-core'
import { createSelectSchema, createInsertSchema } from 'drizzle-zod'
import { relations } from 'drizzle-orm'
// Type-only and relative: drizzle-kit and the migration bundle load this file without
// Nuxt aliases, and the bundle ships only server/db/ + drizzle/.
import type {
  GateResult,
  ImportResult,
  ModelMetadata,
  QuickHangups,
  UploadReport,
} from '../../shared/types/api'

export const user = sqliteTable('user', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('createdAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  role: text('role', { enum: ['viewer', 'admin'] })
    .notNull()
    .default('viewer'),
})

export const session = sqliteTable(
  'session',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('createdAt', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)]
)

export const account = sqliteTable(
  'account',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('createdAt', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('account_userId_idx').on(table.userId)]
)

export const verification = sqliteTable(
  'verification',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updatedAt', { mode: 'timestamp' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)]
)

// ---------------------------------------------------------------------------
// Vets4Warriors tables (docs/architecture.md). SQL names are snake_case because the
// Python retrain script reads and writes them. Timestamps are unix seconds, dates
// 'YYYY-MM-DD', call timestamps naive Eastern wall-clock 'YYYY-MM-DDTHH:MM:SS'.

export const uploads = sqliteTable(
  'uploads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: ['upload', 'postgres-copy'] }).notNull(),
    status: text('status', {
      enum: ['parsing', 'ready', 'invalid', 'importing', 'imported', 'discarded', 'failed'],
    }).notNull(),
    filename: text('filename').notNull(),
    fileSha256: text('file_sha256').notNull(),
    fileBytes: integer('file_bytes').notNull(),
    uploadedBy: text('uploaded_by').references(() => user.id, { onDelete: 'set null' }),
    uploadedByLabel: text('uploaded_by_label').notNull(), // email at the time, or 'cli'
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    parsedAt: integer('parsed_at', { mode: 'timestamp' }),
    importedAt: integer('imported_at', { mode: 'timestamp' }),
    importedByLabel: text('imported_by_label'),
    totalRows: integer('total_rows'),
    firstDay: text('first_day'),
    lastDay: text('last_day'),
    report: text('report_json', { mode: 'json' }).$type<UploadReport>(),
    result: text('result_json', { mode: 'json' }).$type<ImportResult>(),
    error: text('error'),
    runId: integer('run_id'), // forecast_runs.id started by this import (no FK on purpose)
  },
  (t) => [index('uploads_created_idx').on(t.createdAt), index('uploads_sha_idx').on(t.fileSha256)]
)

export const uploadRows = sqliteTable(
  'upload_rows',
  {
    // staged calls of a parsed upload
    id: integer('id').primaryKey({ autoIncrement: true }),
    uploadId: integer('upload_id')
      .notNull()
      .references(() => uploads.id, { onDelete: 'cascade' }),
    startTs: text('start_ts').notNull(),
    inQueueSec: real('in_queue_sec').notNull(),
    agentSec: real('agent_sec').notNull(),
    abandonSec: real('abandon_sec').notNull(),
    routingSec: real('routing_sec').notNull(),
    abandoned: integer('abandoned', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('upload_rows_upload_idx').on(t.uploadId, t.startTs)]
)

export const calls = sqliteTable(
  'calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startTs: text('start_ts').notNull(),
    inQueueSec: real('in_queue_sec'), // nullable: the old Postgres columns are nullable and the copy must be faithful
    agentSec: real('agent_sec'),
    abandonSec: real('abandon_sec'),
    routingSec: real('routing_sec'),
    abandoned: integer('abandoned', { mode: 'boolean' }).notNull(),
    uploadId: integer('upload_id')
      .notNull()
      .references(() => uploads.id),
  },
  (t) => [index('calls_start_ts_idx').on(t.startTs)]
)

export const replacedCalls = sqliteTable(
  'replaced_calls',
  {
    // what an explicit day replacement removed
    id: integer('id').primaryKey({ autoIncrement: true }),
    replacedByUploadId: integer('replaced_by_upload_id')
      .notNull()
      .references(() => uploads.id),
    originalUploadId: integer('original_upload_id'),
    startTs: text('start_ts').notNull(),
    inQueueSec: real('in_queue_sec'),
    agentSec: real('agent_sec'),
    abandonSec: real('abandon_sec'),
    routingSec: real('routing_sec'),
    abandoned: integer('abandoned', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('replaced_calls_upload_idx').on(t.replacedByUploadId)]
)

export const holidays = sqliteTable('holidays', {
  holidayDate: text('holiday_date').primaryKey(), // 'YYYY-MM-DD'
  holidayName: text('holiday_name').notNull(),
})

export const dataState = sqliteTable('data_state', {
  // single row, id = 1; may not exist yet: treat as revision 0
  id: integer('id').primaryKey(),
  callsRevision: integer('calls_revision').notNull().default(0), // +1 on every import that changed `calls`
  rerunRequested: integer('rerun_requested', { mode: 'boolean' }).notNull().default(false),
  // The run queued behind the active one, as asked for: null while nothing is queued
  // (or for a flag set before these columns existed: a full run after an import).
  rerunMode: text('rerun_mode', { enum: ['full', 'forecast-only'] }),
  rerunTrigger: text('rerun_trigger', { enum: ['import', 'manual'] }),
  rerunRequestedBy: text('rerun_requested_by'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const forecastRuns = sqliteTable(
  'forecast_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trigger: text('trigger', {
      enum: ['import', 'schedule', 'manual', 'startup', 'cli'],
    }).notNull(),
    mode: text('mode', { enum: ['full', 'forecast-only'] }).notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'rejected', 'failed', 'interrupted'],
    }).notNull(),
    requestedByLabel: text('requested_by_label'), // email, or 'schedule' / 'startup' / 'cli'
    uploadId: integer('upload_id'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    finishedAt: integer('finished_at', { mode: 'timestamp' }),
    pid: integer('pid'),
    exitCode: integer('exit_code'),
    callsRevision: integer('calls_revision'), // set by Python: the revision it read
    callsCount: integer('calls_count'),
    dataStart: text('data_start'), // first / last call day it read
    dataEnd: text('data_end'),
    trained: integer('trained', { mode: 'boolean' }), // fitted and saved a NEW model
    modelId: integer('model_id'), // model_artifacts.id serving after this run
    gatePassed: integer('gate_passed', { mode: 'boolean' }),
    gate: text('gate_json', { mode: 'json' }).$type<GateResult>(),
    forecastWritten: integer('forecast_written', { mode: 'boolean' }),
    horizonStart: text('horizon_start'),
    horizonEnd: text('horizon_end'),
    message: text('message'), // one or two plain sentences for the admin page
    logTail: text('log_tail'), // last 16 KB of stdout+stderr (never contains call records)
  },
  (t) => [
    index('forecast_runs_status_idx').on(t.status),
    index('forecast_runs_created_idx').on(t.createdAt),
  ]
)

export const modelArtifacts = sqliteTable('model_artifacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  modelSha256: text('model_sha256').notNull(),
  modelText: text('model_text').notNull(), // LightGBM model string (about 1.8 MB)
  metadata: text('metadata_json', { mode: 'json' }).notNull().$type<ModelMetadata>(),
  trainStart: text('train_start').notNull(), // 'YYYY-MM-DDTHH:MM:SS'
  trainEnd: text('train_end').notNull(),
  trainRows: integer('train_rows').notNull(),
})

export const forecastState = sqliteTable('forecast_state', {
  // single row, id = 1: what is being served
  id: integer('id').primaryKey(),
  runId: integer('run_id').notNull(),
  modelId: integer('model_id').notNull(),
  generatedAt: integer('generated_at', { mode: 'timestamp' }).notNull(),
  callsRevision: integer('calls_revision').notNull(),
  callsCount: integer('calls_count').notNull(),
  dataStart: text('data_start').notNull(),
  dataEnd: text('data_end').notNull(),
  horizonStart: text('horizon_start').notNull(),
  horizonEnd: text('horizon_end').notNull(),
  patienceSec: real('patience_sec').notNull(),
  patienceNAbandoned: integer('patience_n_abandoned').notNull(),
  patienceNCalls: integer('patience_n_calls').notNull(),
  quickHangups: text('quick_hangups_json', { mode: 'json' }).notNull().$type<QuickHangups>(),
})

export const forecastHours = sqliteTable(
  'forecast_hours',
  {
    date: text('date').notNull(), // 'YYYY-MM-DD'
    hour: integer('hour').notNull(), // 0..23
    predictedCalls: real('predicted_calls').notNull(), // include_holidays = true
    predictedCallsNoHolidays: real('predicted_calls_no_holidays').notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.hour] })]
)

export const forecastCells = sqliteTable(
  'forecast_cells',
  {
    recency: text('recency', { enum: ['equal', 'weighted', 'recent'] }).notNull(),
    dow: integer('dow').notNull(), // ISO: 1 = Monday .. 7 = Sunday
    hour: integer('hour').notNull(),
    ahtSec: real('aht_sec').notNull(),
    realShare: real('real_share').notNull(), // share of calls with > 120 s talk time
  },
  (t) => [primaryKey({ columns: [t.recency, t.dow, t.hour] })]
)

export const forecastSnapshots = sqliteTable(
  'forecast_snapshots',
  {
    // What the served forecast said for a day at the moment that day's calls were first
    // imported: kept so accuracy can be measured after a retrain has learned the day.
    // Written by the web app only (the import); Python never touches it.
    date: text('date').notNull(), // 'YYYY-MM-DD'
    hour: integer('hour').notNull(), // 0..23
    predictedCalls: real('predicted_calls').notNull(), // include_holidays = true
    modelId: integer('model_id').notNull(), // model_artifacts.id that made it (no FK on purpose)
    runId: integer('run_id').notNull(), // forecast_runs.id that wrote it
    uploadId: integer('upload_id').notNull(), // the import that brought the day's calls
    capturedAt: integer('captured_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.hour] })]
)

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}))

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}))

export const selectUserSchema = createSelectSchema(user)
export const insertUserSchema = createInsertSchema(user)
export const selectSessionSchema = createSelectSchema(session)
export const insertSessionSchema = createInsertSchema(session)
export const selectAccountSchema = createSelectSchema(account)
export const insertAccountSchema = createInsertSchema(account)
export const selectVerificationSchema = createSelectSchema(verification)
export const insertVerificationSchema = createInsertSchema(verification)
export const selectUploadsSchema = createSelectSchema(uploads)
export const insertUploadsSchema = createInsertSchema(uploads)
export const selectUploadRowsSchema = createSelectSchema(uploadRows)
export const insertUploadRowsSchema = createInsertSchema(uploadRows)
export const selectCallsSchema = createSelectSchema(calls)
export const insertCallsSchema = createInsertSchema(calls)
export const selectReplacedCallsSchema = createSelectSchema(replacedCalls)
export const insertReplacedCallsSchema = createInsertSchema(replacedCalls)
export const selectHolidaysSchema = createSelectSchema(holidays)
export const insertHolidaysSchema = createInsertSchema(holidays)
export const selectDataStateSchema = createSelectSchema(dataState)
export const insertDataStateSchema = createInsertSchema(dataState)
export const selectForecastRunsSchema = createSelectSchema(forecastRuns)
export const insertForecastRunsSchema = createInsertSchema(forecastRuns)
export const selectModelArtifactsSchema = createSelectSchema(modelArtifacts)
export const insertModelArtifactsSchema = createInsertSchema(modelArtifacts)
export const selectForecastStateSchema = createSelectSchema(forecastState)
export const insertForecastStateSchema = createInsertSchema(forecastState)
export const selectForecastHoursSchema = createSelectSchema(forecastHours)
export const insertForecastHoursSchema = createInsertSchema(forecastHours)
export const selectForecastCellsSchema = createSelectSchema(forecastCells)
export const insertForecastCellsSchema = createInsertSchema(forecastCells)
export const selectForecastSnapshotsSchema = createSelectSchema(forecastSnapshots)
export const insertForecastSnapshotsSchema = createInsertSchema(forecastSnapshots)
