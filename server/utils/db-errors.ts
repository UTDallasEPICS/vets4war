// A database that is busy for longer than the wait (the retrain script holds the write
// lock), read-only or full surfaced as Nitro's bare 500 "Server Error". These turn
// into the API's one error shape with a sentence an admin can act on;
// server/plugins/04.database-errors.ts applies them to every request.
import { setResponseHeader, type H3Error, type H3Event } from 'h3'
import { apiError } from './http'

// A write lock lasts as long as one step of a retrain: a minute is a fair first retry.
const BUSY_RETRY_SEC = 60

interface DatabaseProblem {
  status: number
  code: string
  message: string
}

const BUSY: DatabaseProblem = {
  status: 503,
  code: 'database_busy',
  message:
    'The database is busy with another write (a retrain, say). Nothing was changed. Try again in a minute.',
}
const READ_ONLY: DatabaseProblem = {
  status: 500,
  code: 'database_read_only',
  message:
    'The server cannot write to its database: the file or its folder is read-only. Nothing was changed. Ask whoever runs the server to check the volume.',
}
const FULL: DatabaseProblem = {
  status: 500,
  code: 'database_full',
  message:
    'The disk that holds the database is full. Nothing was changed. Ask whoever runs the server to free space.',
}

// The SQLite result code of an error or of anything it wraps (Drizzle and h3 keep the
// original as `cause`).
export function sqliteCode(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('SQLITE_')) return code
    e = (e as { cause?: unknown }).cause
  }
  return null
}

export function databaseProblem(error: unknown): DatabaseProblem | null {
  const code = sqliteCode(error)
  if (!code) return null
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return BUSY
  if (code.startsWith('SQLITE_READONLY')) return READ_ONLY
  if (code === 'SQLITE_FULL') return FULL
  return null
}

// Gives a request's error the API's shape when it came from the database; logs the
// SQLite code, which the answer leaves out. Returns whether it did.
export function shapeDatabaseError(error: H3Error, event: H3Event | undefined): boolean {
  const problem = databaseProblem(error)
  if (!problem) return false
  const shaped = apiError(problem.status, problem.code, problem.message)
  console.error(
    `[db] ${event ? `${event.method} ${event.path}: ` : ''}${sqliteCode(error)} (${problem.code})`
  )
  Object.assign(error, {
    statusCode: shaped.statusCode,
    statusMessage: shaped.statusMessage,
    message: shaped.message,
    data: shaped.data,
    // Not a crash of ours: the answer may carry the message (Nitro hides an unhandled one).
    unhandled: false,
  })
  if (event && problem === BUSY) setResponseHeader(event, 'Retry-After', BUSY_RETRY_SEC)
  return true
}
