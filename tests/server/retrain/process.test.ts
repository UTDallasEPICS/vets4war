// The runner with REAL child processes: fixtures/fake-python.mjs plays the process
// contract of PLAN.md section 7 against a migrated SQLite file on disk.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import {
  LOG_TAIL_BYTES,
  createRetrainRunner,
  getRun,
  type RetrainConfig,
} from '../../../server/utils/retrain/runner'

const FAKE = fileURLToPath(new URL('./fixtures/fake-python.mjs', import.meta.url))
const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))
// Real processes on a shared, busy machine: generous, but far below the test timeout.
const SLOW = 30_000

let folder: string
let sqlite: Database.Database
let db: AppDb
let config: RetrainConfig

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'v4w-retrain-test-'))
  const path = join(folder, 'v4w.db')
  sqlite = new Database(path, { timeout: 15_000 })
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS })
  const upload = db
    .insert(schema.uploads)
    .values({
      source: 'upload',
      status: 'imported',
      filename: 'SYNTHETIC.xlsx',
      fileSha256: 'x',
      fileBytes: 1,
      uploadedByLabel: 'admin@example.org',
      createdAt: new Date(),
    })
    .returning()
    .get()
  db.insert(schema.calls)
    .values([
      { startTs: '2026-11-05T08:00:00', abandoned: false, uploadId: upload.id },
      { startTs: '2026-11-06T09:00:00', abandoned: true, uploadId: upload.id },
    ])
    .run()
  db.insert(schema.dataState).values({ id: 1, callsRevision: 1, updatedAt: new Date() }).run()
  config = {
    pythonPath: FAKE,
    module: 'db.retrain',
    forecastDir: folder,
    dbPath: path,
    timeoutMs: 60_000,
    scheduleEnabled: true,
  }
})

afterEach(async () => {
  delete process.env.FAKE_RETRAIN
  delete process.env.FAKE_RETRAIN_NOISE
  sqlite.close()
  await rm(folder, { recursive: true, force: true })
})

async function runWith(behaviour: string, overrides: Partial<RetrainConfig> = {}) {
  process.env.FAKE_RETRAIN = behaviour
  const runner = createRetrainRunner(db, { ...config, ...overrides })
  const { run } = runner.request({ trigger: 'manual', requestedBy: 'admin@example.org' })
  await runner.idle()
  return getRun(db, run.id)
}

describe('real child processes', () => {
  it(
    'succeed: Python claims the row, writes the forecast tables and reports',
    async () => {
      const run = await runWith('succeed')
      expect(run).toMatchObject({
        status: 'succeeded',
        exitCode: 0,
        callsRevision: 1,
        callsCount: 2,
        dataStart: '2026-11-05',
        dataEnd: '2026-11-06',
        forecastWritten: true,
        trained: true,
      })
      expect(run.pid).toBeGreaterThan(0)
      expect(run.startedAt).not.toBeNull()
      expect(run.logTail).toMatch(/V4W_RESULT \{"run_id":\d+,"status":"succeeded"/)
      expect(db.select().from(schema.forecastState).get()?.runId).toBe(run.id)
    },
    SLOW
  )

  it(
    'reject: the row says rejected, exit 3',
    async () => {
      expect(await runWith('reject')).toMatchObject({
        status: 'rejected',
        exitCode: 3,
        forecastWritten: false,
      })
    },
    SLOW
  )

  it(
    'refuse: the row says failed with the reason, exit 2',
    async () => {
      const run = await runWith('refuse')
      expect(run).toMatchObject({ status: 'failed', exitCode: 2 })
      expect(run.message).toMatch(/^Cannot retrain: /)
    },
    SLOW
  )

  it(
    'crash: the process never reported, so the runner fails the row',
    async () => {
      const run = await runWith('crash')
      expect(run).toMatchObject({
        status: 'failed',
        exitCode: 1,
        message: 'The retrain script stopped without reporting a result (exit code 1).',
      })
      expect(run.logTail).toContain('RuntimeError: FAKE crash')
    },
    SLOW
  )

  it(
    'hang: the timeout stops the process and fails the row',
    async () => {
      const started = Date.now()
      const run = await runWith('hang', { timeoutMs: 1500 })
      expect(run).toMatchObject({
        status: 'failed',
        exitCode: null,
        message: 'Stopped after 0.03 minutes (V4W_RETRAIN_TIMEOUT_MIN).',
      })
      expect(Date.now() - started).toBeLessThan(SLOW)
      expect(() => process.kill(run.pid!, 0)).toThrow()
    },
    SLOW
  )

  it(
    'stores the end of the output, capped at 16 KB',
    async () => {
      process.env.FAKE_RETRAIN_NOISE = String(64 * 1024)
      const run = await runWith('succeed')
      expect(Buffer.byteLength(run.logTail!)).toBe(LOG_TAIL_BYTES)
      expect(run.logTail).toMatch(/V4W_RESULT .*\n$/)
    },
    SLOW
  )

  it(
    'an interpreter that does not exist fails the run with the reason',
    async () => {
      const run = await runWith('succeed', { pythonPath: join(folder, 'no-such-python') })
      expect(run).toMatchObject({
        status: 'failed',
        exitCode: null,
        message: 'The retrain script could not be started (ENOENT).',
      })
    },
    SLOW
  )
})
