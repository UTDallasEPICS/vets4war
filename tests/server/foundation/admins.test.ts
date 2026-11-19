import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { ensureAdmins, parseAdminEmails } from '../../../server/db/admins'
import * as schema from '../../../server/db/schema'
import { createTestDb, createTestUser } from '../../helpers/db'

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))

function roleOf(db: ReturnType<typeof createTestDb>['db'], email: string) {
  return db.select().from(schema.user).where(eq(schema.user.email, email)).get()?.role
}

describe('ensureAdmins', () => {
  it('creates a missing admin, named after the address', () => {
    const { db } = createTestDb()
    expect(ensureAdmins(db, ['admin@example.org'])).toEqual({
      created: ['admin@example.org'],
      promoted: [],
    })
    const row = db.select().from(schema.user).get()
    expect(row).toMatchObject({ email: 'admin@example.org', name: 'admin', role: 'admin' })
  })

  it('promotes a viewer', () => {
    const { db } = createTestDb()
    createTestUser(db, { email: 'v@example.org' })
    expect(ensureAdmins(db, ['v@example.org'])).toEqual({
      created: [],
      promoted: ['v@example.org'],
    })
    expect(roleOf(db, 'v@example.org')).toBe('admin')
  })

  it('is idempotent', () => {
    const { db } = createTestDb()
    ensureAdmins(db, ['a@example.org'])
    expect(ensureAdmins(db, ['a@example.org'])).toEqual({ created: [], promoted: [] })
    expect(db.select().from(schema.user).all()).toHaveLength(1)
  })

  it('never demotes or deletes anyone', () => {
    const { db } = createTestDb()
    createTestUser(db, { email: 'old@example.org', role: 'admin' })
    createTestUser(db, { email: 'viewer@example.org' })
    ensureAdmins(db, ['new@example.org'])
    expect(roleOf(db, 'old@example.org')).toBe('admin')
    expect(roleOf(db, 'viewer@example.org')).toBe('viewer')
    expect(ensureAdmins(db, [])).toEqual({ created: [], promoted: [] })
    expect(db.select().from(schema.user).all()).toHaveLength(3)
  })

  it('treats mixed-case input as the same address', () => {
    const { db } = createTestDb()
    createTestUser(db, { email: 'mixed@example.org' })
    expect(ensureAdmins(db, [' Mixed@Example.ORG ', 'mixed@example.org'])).toEqual({
      created: [],
      promoted: ['mixed@example.org'],
    })
    expect(db.select().from(schema.user).all()).toHaveLength(1)
  })
})

describe('parseAdminEmails', () => {
  it('splits, trims, lower-cases and de-duplicates', () => {
    expect(parseAdminEmails(' A@x.org, b@x.org,,a@X.org ')).toEqual(['a@x.org', 'b@x.org'])
    expect(parseAdminEmails(undefined)).toEqual([])
    expect(parseAdminEmails('')).toEqual([])
  })

  it('names an entry that is not an address', () => {
    expect(() => parseAdminEmails('a@x.org, not-an-email')).toThrow('"not-an-email"')
  })
})

describe('ensureAdmins while another connection holds the write lock', () => {
  // The Python retrain writes into the same file. A deferred transaction that reads and
  // then writes gets SQLITE_BUSY at once instead of waiting for the lock; an immediate
  // one waits (busy timeout) and then succeeds.
  it('waits for the lock instead of failing with SQLITE_BUSY', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v4w-admins-'))
    const file = join(dir, 'lock.db')
    try {
      const setup = new Database(file)
      migrate(drizzle(setup, { schema }), { migrationsFolder: MIGRATIONS })
      setup.close()

      // A second process takes the write lock, writes, and holds it for HOLD_MS.
      const HOLD_MS = 700
      const holder = spawn(
        process.execPath,
        [
          '-e',
          `const D = require('better-sqlite3'); const db = new D(process.argv[1]);
           db.exec('BEGIN IMMEDIATE'); db.prepare("INSERT INTO holidays VALUES ('2026-12-25', 'Christmas Day')").run();
           process.stdout.write('locked\\n');
           setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${HOLD_MS});`,
          file,
        ],
        { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] }
      )
      const exited = new Promise((resolve) => holder.on('exit', resolve))
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', (chunk) => String(chunk).includes('locked') && resolve())
        holder.on('error', reject)
      })

      const sqlite = new Database(file, { timeout: 10000 })
      sqlite.pragma('foreign_keys = ON')
      const started = Date.now()
      const result = ensureAdmins(drizzle(sqlite, { schema }), ['admin@example.org'])
      const waited = Date.now() - started
      sqlite.close()
      await exited

      expect(result).toEqual({ created: ['admin@example.org'], promoted: [] })
      expect(waited).toBeGreaterThan(HOLD_MS / 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
