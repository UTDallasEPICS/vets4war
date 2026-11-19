// Review X-2: while another connection (the retrain script) holds SQLite's write lock,
// an upload or an import must wait for it (busy timeout), not fail at once with
// SQLITE_BUSY as a deferred read-then-write transaction does. On-disk database; the
// lock is held by a separate process, as the script holds it.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  discardUpload,
  getUpload,
  importUpload,
  receiveUpload,
  type IngestDeps,
} from '../../../server/utils/ingest/service'
import { rawLayout, wholeDay, writeWorkbook } from './fixtures/workbooks'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const MIGRATIONS = join(REPO, 'drizzle')
const HOLD_MS = 1500

let folder: string
let path: string
let sqlite: Database.Database
let db: AppDb
let holder: ChildProcess | null = null

const deps: IngestDeps = { maxBytes: 1e8, maxRows: 10_000, today: () => '2026-11-19' }
const admin = { id: '', email: 'admin@example.org' }

// Another process takes the write lock (BEGIN IMMEDIATE), holds it, then commits.
function holdWriteLock(ms: number): Promise<void> {
  const code = `
    const Database = require('better-sqlite3')
    const db = new Database(${JSON.stringify(path)})
    db.exec('BEGIN IMMEDIATE')
    db.prepare("UPDATE uploads SET filename = filename WHERE id = 0").run()
    process.stdout.write('locked\\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms})
    db.exec('COMMIT')
  `
  holder = spawn(process.execPath, ['-e', code], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    holder!.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) resolve()
    })
    holder!.on('error', reject)
    holder!.on('exit', (code) => reject(new Error(`lock holder exited early (${code})`)))
  })
}

async function readyUpload(day: string) {
  const file = await writeWorkbook(join(folder, `${day}.xlsx`), rawLayout(wholeDay(day)))
  const received = await receiveUpload(
    db,
    { ...deps, tmpDir: folder },
    {
      filename: 'SYNTHETIC calls.xlsx',
      data: await readFile(file),
      user: admin,
    }
  )
  await received.parsing
  return getUpload(db, received.upload.id)
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'v4w-locking-test-'))
  path = join(folder, 'app.db')
  sqlite = new Database(path, { timeout: 15_000 })
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS })
  admin.id = db
    .insert(schema.user)
    .values({ email: admin.email, name: 'admin', role: 'admin' })
    .returning({ id: schema.user.id })
    .get().id
})

afterEach(async () => {
  holder?.kill('SIGKILL')
  holder = null
  sqlite.close()
  await rm(folder, { recursive: true, force: true })
})

describe('writes while another process holds the write lock', () => {
  it('an import waits for the lock and then imports', async () => {
    const row = await readyUpload('2026-11-05')
    await holdWriteLock(HOLD_MS)
    const started = performance.now()
    const { upload } = importUpload(db, deps, row.id, { total_rows: 24, replace_days: [] }, admin)
    expect(upload.status).toBe('imported')
    expect(performance.now() - started).toBeGreaterThan(HOLD_MS / 3)
  })

  it('a discard waits for the lock too', async () => {
    const row = await readyUpload('2026-11-06')
    await holdWriteLock(HOLD_MS)
    expect(discardUpload(db, row.id).status).toBe('discarded')
  })
})
