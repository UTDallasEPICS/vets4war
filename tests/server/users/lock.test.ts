// A people change that lands while another process (the Python retrain) holds SQLite's
// write lock must wait for it (busy timeout), not fail with SQLITE_BUSY. A DEFERRED
// transaction that reads first and then writes gets SQLITE_BUSY at once, without the
// busy handler; an IMMEDIATE one takes the write lock up front and waits.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import { addPerson, removePerson, updatePerson } from '../../../server/utils/users'

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))
const BETTER_SQLITE3 = createRequire(import.meta.url).resolve('better-sqlite3')
const HOLD_MS = 1500

// Another process takes the write lock (BEGIN IMMEDIATE), says so, holds it, commits.
function holdWriteLock(path: string): Promise<ChildProcess> {
  const script = `
    const Database = require(${JSON.stringify(BETTER_SQLITE3)})
    const db = new Database(${JSON.stringify(path)})
    db.exec('BEGIN IMMEDIATE')
    process.stdout.write('locked\\n')
    setTimeout(() => { db.exec('COMMIT'); db.close() }, ${HOLD_MS})
  `
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) resolve(child)
    })
    child.on('error', reject)
    child.on('exit', (code) => reject(new Error(`lock holder exited early (${code})`)))
  })
}

describe('people changes while another process holds the write lock', () => {
  let dir: string
  let sqlite: Database.Database
  let db: AppDb
  let adminId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'v4w-lock-'))
    // The same busy timeout as server/utils/db.ts.
    sqlite = new Database(join(dir, 'app.db'), { timeout: 15000 })
    sqlite.pragma('foreign_keys = ON')
    db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: MIGRATIONS })
    adminId = addPerson(db, { email: 'admin@example.org', role: 'admin' }).id
  })

  afterEach(() => {
    sqlite.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('waits for the lock instead of failing: add, update, remove', async () => {
    const path = join(dir, 'app.db')

    let holder = await holdWriteLock(path)
    let started = performance.now()
    const viewer = addPerson(db, { email: 'v@example.org', role: 'viewer' })
    expect(performance.now() - started).toBeGreaterThan(HOLD_MS / 2)
    holder.kill()

    holder = await holdWriteLock(path)
    started = performance.now()
    expect(updatePerson(db, adminId, viewer.id, { role: 'admin' }).role).toBe('admin')
    expect(performance.now() - started).toBeGreaterThan(HOLD_MS / 2)
    holder.kill()

    holder = await holdWriteLock(path)
    started = performance.now()
    removePerson(db, adminId, viewer.id)
    expect(performance.now() - started).toBeGreaterThan(HOLD_MS / 2)
    holder.kill()
  }, 30_000)
})
