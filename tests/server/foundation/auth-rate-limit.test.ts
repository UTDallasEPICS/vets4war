// Asking for sign-in codes is rate limited in every build, whatever NODE_ENV says.
// Better Auth's own default switches the limit on only when the process runs with
// NODE_ENV=production; a production build started with plain `node` has no NODE_ENV, and
// the limit is what keeps someone who knows an address from guessing its codes. Here
// NODE_ENV is 'test' (vitest), so the fourth request passes without the explicit setting
// in server/utils/auth.ts.
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Never the developer's database from .env.
  process.env.DATABASE_URL = 'file::memory:'
})

const { db } = await import('../../../server/utils/db')
const { auth } = await import('../../../server/utils/auth')
const { env } = await import('../../../server/utils/env')

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))
// Better Auth's limit on the sign-in code routes: 3 requests per 60 s for one client.
const ALLOWED_PER_MINUTE = 3

function askForCode(email: string) {
  return auth.handler(
    new Request(new URL('/api/auth/email-otp/send-verification-otp', env.BETTER_AUTH_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.BETTER_AUTH_URL },
      body: JSON.stringify({ email, type: 'sign-in' }),
    })
  )
}

describe('sign-in rate limit', () => {
  beforeAll(() => {
    migrate(db, { migrationsFolder: MIGRATIONS })
  })

  it('refuses the fourth request for a code within a minute, without NODE_ENV=production', async () => {
    expect(process.env.NODE_ENV).not.toBe('production')
    const statuses: number[] = []
    for (let i = 0; i < ALLOWED_PER_MINUTE + 1; i++) {
      // An address nobody added: the same answer as for a real one, and no mail.
      statuses.push((await askForCode('nobody@example.org')).status)
    }
    expect(statuses).toEqual([200, 200, 200, 429])
  })
})
