// pnpm db:seed: make every V4W_ADMIN_EMAILS address an admin, nothing else. Runs under
// tsx outside Nitro (and from the migration bundle, which ships only server/db/ and
// drizzle/), so it reads process.env itself instead of importing server/utils/env.ts.
import 'dotenv/config'
import { isAbsolute, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { ensureAdmins, parseAdminEmails } from './admins'
import * as schema from './schema'

function databasePath(url: string): string {
  const path = url.startsWith('file:') ? url.slice('file:'.length) : url
  return path === ':memory:' || isAbsolute(path) ? path : resolve(process.cwd(), path)
}

const path = databasePath(process.env.DATABASE_URL?.trim() || 'file:./dev.db')
const sqlite = new Database(path, { timeout: 15000 })
sqlite.pragma('foreign_keys = ON')
const db = drizzle(sqlite, { schema })

try {
  const emails = parseAdminEmails(process.env.V4W_ADMIN_EMAILS)
  console.log(`Seeding ${path}`)
  if (emails.length === 0) {
    console.log('V4W_ADMIN_EMAILS is empty: no admin to add.')
  } else {
    const { created, promoted } = ensureAdmins(db, emails)
    for (const email of emails) {
      const what = created.includes(email)
        ? 'created as admin'
        : promoted.includes(email)
          ? 'promoted to admin'
          : 'already an admin'
      console.log(`  ${email}: ${what}`)
    }
  }
  console.log('Seeding finished.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  sqlite.close()
}
