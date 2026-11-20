// A migrated in-memory database for tests/server/** (node environment). It runs the
// committed migrations, so a test sees exactly the schema a real database gets.
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '../../server/db/schema'
import type { AppDb } from '../../server/utils/db'

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))

export function createTestDb(): { db: AppDb; sqlite: Database.Database } {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS })
  return { db, sqlite }
}

export function createTestUser(
  db: AppDb,
  values: { email: string; role?: 'viewer' | 'admin'; name?: string }
): { id: string; email: string; role: 'viewer' | 'admin' } {
  const row = db
    .insert(schema.user)
    .values({
      email: values.email,
      name: values.name ?? values.email.split('@')[0] ?? values.email,
      role: values.role ?? 'viewer',
    })
    .returning({ id: schema.user.id, email: schema.user.email, role: schema.user.role })
    .get()
  return row
}
