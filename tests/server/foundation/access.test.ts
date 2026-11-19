import { describe, it, expect } from 'vitest'
import { checkAccess } from '../../../server/utils/access'

const AUTH = 'http://localhost:3100'
const viewer = { role: 'viewer' }
const admin = { role: 'admin' }

type Row = {
  name: string
  path: string
  method?: string
  origin?: string | null
  user: { role: string } | null
  expect: { ok: true } | { status: 401 | 403; code: 'unauthorized' | 'forbidden' }
}

const ROWS: Row[] = [
  { name: 'a page passes without a session', path: '/admin', user: null, expect: { ok: true } },
  { name: 'an asset passes', path: '/_nuxt/entry.js', user: null, expect: { ok: true } },
  { name: 'health is public', path: '/api/health', user: null, expect: { ok: true } },
  {
    name: 'Better Auth is public',
    path: '/api/auth/email-otp/send-verification-otp',
    method: 'POST',
    origin: 'http://evil.example',
    user: null,
    expect: { ok: true },
  },
  {
    name: 'auth get-session with a query',
    path: '/api/auth/get-session?x=1',
    user: null,
    expect: { ok: true },
  },
  {
    name: 'a lookalike of a public prefix is not public',
    path: '/api/healthz',
    user: null,
    expect: { status: 401, code: 'unauthorized' },
  },
  {
    name: 'no session is 401',
    path: '/api/status',
    user: null,
    expect: { status: 401, code: 'unauthorized' },
  },
  {
    name: 'no session on an admin path is 401, not 403',
    path: '/api/admin/runs',
    user: null,
    expect: { status: 401, code: 'unauthorized' },
  },
  {
    name: 'a viewer reads the forecast',
    path: '/api/forecast?start=2026-11-19',
    user: viewer,
    expect: { ok: true },
  },
  {
    name: 'a viewer on /api/admin/x is 403',
    path: '/api/admin/x',
    user: viewer,
    expect: { status: 403, code: 'forbidden' },
  },
  {
    name: 'a viewer on an encoded admin path is 403',
    path: '/api/%61dmin/users',
    user: viewer,
    expect: { status: 403, code: 'forbidden' },
  },
  {
    name: 'a viewer on a doubled slash admin path is 403',
    path: '/api//admin/users',
    user: viewer,
    expect: { status: 403, code: 'forbidden' },
  },
  {
    name: 'a viewer on an upper-case admin path is 403',
    path: '/API/ADMIN/users',
    user: viewer,
    expect: { status: 403, code: 'forbidden' },
  },
  { name: 'an admin passes', path: '/api/admin/runs', user: admin, expect: { ok: true } },
  {
    name: 'a cross-origin POST is 403',
    path: '/api/admin/runs',
    method: 'POST',
    origin: 'http://evil.example',
    user: admin,
    expect: { status: 403, code: 'forbidden' },
  },
  {
    name: 'a cross-origin DELETE is 403',
    path: '/api/admin/uploads/3',
    method: 'delete',
    origin: 'http://localhost:3101',
    user: admin,
    expect: { status: 403, code: 'forbidden' },
  },
  {
    name: 'a POST from an opaque origin is 403',
    path: '/api/planned',
    method: 'POST',
    origin: 'null',
    user: viewer,
    expect: { status: 403, code: 'forbidden' },
  },
  {
    name: 'a same-origin POST passes',
    path: '/api/admin/runs',
    method: 'POST',
    origin: 'http://localhost:3100',
    user: admin,
    expect: { ok: true },
  },
  {
    name: 'a GET with a foreign Origin passes',
    path: '/api/forecast',
    method: 'GET',
    origin: 'http://evil.example',
    user: viewer,
    expect: { ok: true },
  },
  {
    name: 'a POST without Origin passes',
    path: '/api/planned',
    method: 'POST',
    origin: null,
    user: viewer,
    expect: { ok: true },
  },
]

describe('checkAccess', () => {
  it.each(ROWS)('$name', (row) => {
    const result = checkAccess({
      path: row.path,
      method: row.method ?? 'GET',
      origin: row.origin ?? null,
      authOrigin: AUTH,
      user: row.user,
    })
    if ('ok' in row.expect) {
      expect(result).toEqual({ ok: true })
    } else {
      expect(result).toMatchObject({ ok: false, ...row.expect })
      expect((result as { message: string }).message).toBeTruthy()
    }
  })

  it('compares origins, not URLs', () => {
    const result = checkAccess({
      path: '/api/planned',
      method: 'POST',
      origin: 'http://localhost:3100',
      authOrigin: 'http://localhost:3100/some/path',
      user: viewer,
    })
    expect(result).toEqual({ ok: true })
  })
})
