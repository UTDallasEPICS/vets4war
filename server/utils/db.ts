import 'dotenv/config'
import { isAbsolute, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import { env } from './env'

export type AppDb = BetterSQLite3Database<typeof schema>

// DATABASE_URL is `file:<path>`; a relative path resolves against the folder the server
// was started in (the repo root), the same rule drizzle-kit and the seed follow.
export function resolveDatabasePath(url: string, cwd: string): string {
  const path = url.startsWith('file:') ? url.slice('file:'.length) : url
  if (path === ':memory:' || isAbsolute(path)) return path
  return resolve(cwd, path)
}

function open() {
  // The Python retrain script writes into the same file: wait up to 15 s for its lock
  // instead of failing with SQLITE_BUSY. The journal mode is left at the default
  // (delete) on purpose: the file may sit on a network filesystem, where WAL breaks.
  const sqlite = new Database(resolveDatabasePath(env.DATABASE_URL, process.cwd()), {
    timeout: 15000,
  })
  sqlite.pragma('foreign_keys = ON')
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

// One connection per process; `nuxt dev` reloads modules, so keep it on globalThis there.
const globalForDb = globalThis as unknown as { v4wDb: ReturnType<typeof open> | undefined }
const opened = globalForDb.v4wDb ?? open()

if (process.env.NODE_ENV !== 'production') {
  globalForDb.v4wDb = opened
}

export const sqlite = opened.sqlite
export const db: AppDb = opened.db
