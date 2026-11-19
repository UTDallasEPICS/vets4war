// First admins from configuration (V4W_ADMIN_EMAILS). Used by the start-up plugin and
// by the seed script. The seed runs from the migration bundle, which ships only
// server/db/ and drizzle/: this file may import only ./schema and node_modules.
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

// "A@x.org, b@x.org,,a@x.org" -> ['a@x.org', 'b@x.org']. Throws on an entry that does
// not look like an address, naming it.
export function parseAdminEmails(value: string | undefined): string[] {
  const emails: string[] = []
  for (const part of (value ?? '').split(',')) {
    const email = part.trim().toLowerCase()
    if (!email) continue
    if (!EMAIL.test(email)) throw new Error(`"${part.trim()}" is not an email address`)
    if (!emails.includes(email)) emails.push(email)
  }
  return emails
}

// For each address: no user -> create an admin; a viewer -> make admin; an admin ->
// nothing. Never demotes or deletes anyone, so removing an address from the list
// later does not lock that person out.
export function ensureAdmins(
  db: BetterSQLite3Database<typeof schema>,
  emails: string[]
): { created: string[]; promoted: string[] } {
  const created: string[] = []
  const promoted: string[] = []
  db.transaction((tx) => {
    for (const raw of emails) {
      const email = raw.trim().toLowerCase()
      if (!email || created.includes(email) || promoted.includes(email)) continue
      const existing = tx
        .select({ id: schema.user.id, role: schema.user.role })
        .from(schema.user)
        .where(eq(schema.user.email, email))
        .get()
      if (!existing) {
        tx.insert(schema.user)
          .values({ email, name: email.split('@')[0] ?? email, role: 'admin' })
          .run()
        created.push(email)
      } else if (existing.role !== 'admin') {
        tx.update(schema.user)
          .set({ role: 'admin', updatedAt: new Date() })
          .where(eq(schema.user.id, existing.id))
          .run()
        promoted.push(email)
      }
    }
  })
  return { created, promoted }
}
