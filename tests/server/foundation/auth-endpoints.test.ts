// Better Auth serves only the endpoints the app uses: asking for a code, signing in with
// it, reading the session and signing out. Everything else it would serve (set a
// password, change the address, verify an email, manage sessions) answers 404, and the
// list is checked against what this version of Better Auth really serves, so an upgrade
// that adds an endpoint fails here until it is looked at.
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  // Never the developer's database from .env.
  process.env.DATABASE_URL = 'file::memory:'
})

const { db } = await import('../../../server/utils/db')
const { auth, DISABLED_AUTH_PATHS } = await import('../../../server/utils/auth')
const { env } = await import('../../../server/utils/env')

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))

// What the app calls (app/pages/auth.vue, app/utils/auth-client.ts, server middleware),
// plus Better Auth's own health check and error page.
const USED = [
  '/email-otp/send-verification-otp',
  '/sign-in/email-otp',
  '/get-session',
  '/sign-out',
  '/ok',
  '/error',
]

function call(path: string, method: 'GET' | 'POST', body?: unknown) {
  return auth.handler(
    new Request(new URL(`/api/auth${path}`, env.BETTER_AUTH_URL), {
      method,
      headers: { 'content-type': 'application/json', origin: env.BETTER_AUTH_URL },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  )
}

describe('Better Auth endpoints', () => {
  beforeAll(() => {
    migrate(db, { migrationsFolder: MIGRATIONS })
  })

  it('disables every endpoint the app does not use', () => {
    const served = Object.values(auth.api as Record<string, { path?: unknown }>)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === 'string' && !path.includes(':'))
    const unused = [...new Set(served)].filter((path) => !USED.includes(path)).sort()
    expect([...DISABLED_AUTH_PATHS].sort()).toEqual(unused)
  })

  it.each([
    ['/forget-password/email-otp', 'POST'],
    ['/email-otp/request-password-reset', 'POST'],
    ['/email-otp/reset-password', 'POST'],
    ['/email-otp/verify-email', 'POST'],
    ['/email-otp/check-verification-otp', 'POST'],
    ['/update-user', 'POST'],
    ['/change-email', 'POST'],
    ['/delete-user', 'POST'],
    ['/sign-up/email', 'POST'],
    ['/sign-in/email', 'POST'],
    ['/list-sessions', 'GET'],
    ['/revoke-other-sessions', 'POST'],
  ] as const)('answers 404 on %s', async (path, method) => {
    const answer = await call(path, method, method === 'POST' ? {} : undefined)
    expect(answer.status).toBe(404)
  })

  it('still serves the endpoints the app uses', async () => {
    const asked = await call('/email-otp/send-verification-otp', 'POST', {
      email: 'nobody@example.org',
      type: 'sign-in',
    })
    expect(asked.status).toBe(200)
    expect((await call('/get-session', 'GET')).status).toBe(200)
    expect((await call('/ok', 'GET')).status).toBe(200)
    const wrongCode = await call('/sign-in/email-otp', 'POST', {
      email: 'nobody@example.org',
      otp: '000000',
    })
    expect(wrongCode.status).not.toBe(404)
  })
})
