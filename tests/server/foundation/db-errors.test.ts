// A write that the database refuses (busy past the wait, read-only, disk full) answers in
// the API's error shape with a sentence, not Nitro's bare 500 "Server Error". The SQLite
// errors are real ones, from a second connection holding the write lock and from a
// read-only connection; the request goes through h3 as Nitro sends it (the error hook
// shapes the error before the handler writes it).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createApp, eventHandler, toWebHandler, type H3Error } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { databaseProblem, shapeDatabaseError } from '../../../server/utils/db-errors'

let folder: string
let path: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'v4w-db-errors-'))
  path = join(folder, 'app.db')
  const setup = new Database(path)
  setup.exec('CREATE TABLE t (x INTEGER)')
  setup.close()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(folder, { recursive: true, force: true })
})

// The error a write throws, wrapped as Drizzle does.
function writeError(open: () => Database.Database, hold?: Database.Database): unknown {
  hold?.exec('BEGIN IMMEDIATE')
  const db = open()
  try {
    db.prepare('INSERT INTO t VALUES (1)').run()
  } catch (error) {
    return Object.assign(new Error('Failed query'), { cause: error })
  } finally {
    db.close()
    hold?.exec('ROLLBACK')
  }
  throw new Error('expected the write to fail')
}

async function answer(thrown: unknown) {
  const app = createApp({
    onError: (error, event) => {
      shapeDatabaseError(error as H3Error, event)
    },
  })
  app.use(
    eventHandler(() => {
      throw thrown
    })
  )
  const response = await toWebHandler(app)(new Request('http://localhost/api/admin/runs'))
  const body = (await response.json()) as { statusCode: number; data?: { code: string } }
  return {
    status: response.status,
    code: body.data?.code,
    retry: response.headers.get('retry-after'),
  }
}

describe('database errors', () => {
  it('a database busy past the wait is a 503 to retry in a minute', async () => {
    const holder = new Database(path)
    const busy = writeError(() => new Database(path, { timeout: 0 }), holder)
    holder.close()
    expect(databaseProblem(busy)?.message).toBe(
      'The database is busy with another write (a retrain, say). Nothing was changed. Try again in a minute.'
    )
    expect(await answer(busy)).toEqual({ status: 503, code: 'database_busy', retry: '60' })
  })

  it('a read-only database is a 500 that says so', async () => {
    const readOnly = writeError(() => new Database(path, { readonly: true }))
    expect(databaseProblem(readOnly)?.message).toMatch(/^The server cannot write to its database/)
    expect(await answer(readOnly)).toEqual({ status: 500, code: 'database_read_only', retry: null })
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[db\] GET \/api\/admin\/runs: SQLITE_READONLY/)
    )
  })

  it('a full disk is named; any other error is left alone', () => {
    expect(databaseProblem({ code: 'SQLITE_FULL' })?.status).toBe(500)
    expect(databaseProblem({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBeNull()
    expect(databaseProblem(new Error('boom'))).toBeNull()
    const other = Object.assign(new Error('boom'), { statusCode: 500 }) as unknown as H3Error
    expect(shapeDatabaseError(other, undefined)).toBe(false)
    expect(other.message).toBe('boom')
  })
})
