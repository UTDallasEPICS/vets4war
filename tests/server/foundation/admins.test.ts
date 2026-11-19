import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { ensureAdmins, parseAdminEmails } from '../../../server/db/admins'
import * as schema from '../../../server/db/schema'
import { createTestDb, createTestUser } from '../../helpers/db'

function roleOf(db: ReturnType<typeof createTestDb>['db'], email: string) {
  return db.select().from(schema.user).where(eq(schema.user.email, email)).get()?.role
}

describe('ensureAdmins', () => {
  it('creates a missing admin, named after the address', () => {
    const { db } = createTestDb()
    expect(ensureAdmins(db, ['admin@example.org'])).toEqual({
      created: ['admin@example.org'],
      promoted: [],
    })
    const row = db.select().from(schema.user).get()
    expect(row).toMatchObject({ email: 'admin@example.org', name: 'admin', role: 'admin' })
  })

  it('promotes a viewer', () => {
    const { db } = createTestDb()
    createTestUser(db, { email: 'v@example.org' })
    expect(ensureAdmins(db, ['v@example.org'])).toEqual({
      created: [],
      promoted: ['v@example.org'],
    })
    expect(roleOf(db, 'v@example.org')).toBe('admin')
  })

  it('is idempotent', () => {
    const { db } = createTestDb()
    ensureAdmins(db, ['a@example.org'])
    expect(ensureAdmins(db, ['a@example.org'])).toEqual({ created: [], promoted: [] })
    expect(db.select().from(schema.user).all()).toHaveLength(1)
  })

  it('never demotes or deletes anyone', () => {
    const { db } = createTestDb()
    createTestUser(db, { email: 'old@example.org', role: 'admin' })
    createTestUser(db, { email: 'viewer@example.org' })
    ensureAdmins(db, ['new@example.org'])
    expect(roleOf(db, 'old@example.org')).toBe('admin')
    expect(roleOf(db, 'viewer@example.org')).toBe('viewer')
    expect(ensureAdmins(db, [])).toEqual({ created: [], promoted: [] })
    expect(db.select().from(schema.user).all()).toHaveLength(3)
  })

  it('treats mixed-case input as the same address', () => {
    const { db } = createTestDb()
    createTestUser(db, { email: 'mixed@example.org' })
    expect(ensureAdmins(db, [' Mixed@Example.ORG ', 'mixed@example.org'])).toEqual({
      created: [],
      promoted: ['mixed@example.org'],
    })
    expect(db.select().from(schema.user).all()).toHaveLength(1)
  })
})

describe('parseAdminEmails', () => {
  it('splits, trims, lower-cases and de-duplicates', () => {
    expect(parseAdminEmails(' A@x.org, b@x.org,,a@X.org ')).toEqual(['a@x.org', 'b@x.org'])
    expect(parseAdminEmails(undefined)).toEqual([])
    expect(parseAdminEmails('')).toEqual([])
  })

  it('names an entry that is not an address', () => {
    expect(() => parseAdminEmails('a@x.org, not-an-email')).toThrow('"not-an-email"')
  })
})
