import { ensureAdmins } from '../utils/admins'
import { db } from '../utils/db'
import { env } from '../utils/env'

// On every start, make each V4W_ADMIN_EMAILS address an admin (created if needed,
// never demoting anyone), so a fresh deployment has someone who can add people.
export default defineNitroPlugin(() => {
  try {
    const { created, promoted } = ensureAdmins(db, env.V4W_ADMIN_EMAILS)
    for (const email of created) console.log(`[admins] created admin ${email}`)
    for (const email of promoted) console.log(`[admins] made ${email} an admin`)
  } catch (error) {
    if (!isMissingTable(error)) throw error
    // The health route must stay up on an empty file so a deployment can be checked
    // before its first migration.
    console.warn('[admins] database is not migrated: run pnpm db:migrate')
  }
})

function isMissingTable(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (/no such table/i.test(e.message)) return true
  }
  return false
}
