import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { H3Error } from 'h3'
import * as schema from '../../../server/db/schema'
import type { AppDb } from '../../../server/utils/db'
import {
  addPerson,
  listPeople,
  parseNewPerson,
  parsePersonPatch,
  removePerson,
  updatePerson,
} from '../../../server/utils/users'
import { createTestDb, createTestUser } from '../../helpers/db'

interface Failure {
  statusCode: number
  message: string
  code: string
  issues: { path: string }[]
}

function failure(fn: () => unknown): Failure {
  try {
    fn()
  } catch (error) {
    if (!(error instanceof H3Error)) throw error
    const data = error.data as { code: string; issues?: { path: string }[] }
    return {
      statusCode: error.statusCode,
      message: error.message,
      code: data.code,
      issues: data.issues ?? [],
    }
  }
  throw new Error('expected an API error, nothing was thrown')
}

function setup() {
  const { db, sqlite } = createTestDb()
  const admin = createTestUser(db, { email: 'admin@example.org', role: 'admin' })
  return { db, sqlite, admin }
}

function addSession(db: AppDb, userId: string) {
  const now = new Date()
  db.insert(schema.session)
    .values({
      id: `s-${userId}`,
      userId,
      token: `t-${userId}`,
      expiresAt: new Date(now.getTime() + 86_400_000),
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

describe('addPerson', () => {
  it('stores the address trimmed and lower-cased, the name from the address', () => {
    const { db } = setup()
    const person = addPerson(db, { email: '  Jane.Doe@Example.ORG ', role: 'viewer' })
    expect(person).toMatchObject({
      email: 'jane.doe@example.org',
      name: 'jane.doe',
      role: 'viewer',
      email_verified: false,
    })
    expect(person.created_at).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('keeps a given name, trimmed', () => {
    const { db } = setup()
    expect(addPerson(db, { email: 'a@x.org', name: '  Ann  ', role: 'admin' }).name).toBe('Ann')
  })

  it('refuses an address that already has access, whatever its case', () => {
    const { db } = setup()
    addPerson(db, { email: 'a@x.org', role: 'viewer' })
    const error = failure(() => addPerson(db, { email: 'A@X.org', role: 'admin' }))
    expect(error).toMatchObject({
      statusCode: 409,
      code: 'conflict',
      message: 'a@x.org already has access.',
    })
    expect(listPeople(db).filter((p) => p.email === 'a@x.org')).toHaveLength(1)
  })

  it.each([
    [{ email: 'not-an-email', role: 'viewer' }, ['email']],
    [{ email: '', role: 'viewer' }, ['email']],
    [{ email: 'a@x.org', role: 'owner' }, ['role']],
    [{ email: 'a@x.org' }, ['role']],
    [{ email: 'a@x.org', name: '   ', role: 'viewer' }, ['name']],
    [{ email: 'a@x.org', name: 'x'.repeat(101), role: 'viewer' }, ['name']],
    [{ role: 'viewer' }, ['email']],
  ])('rejects %j with 422', (body, paths) => {
    const error = failure(() => parseNewPerson(body))
    expect(error.statusCode).toBe(422)
    expect(error.code).toBe('validation')
    expect(error.issues.map((i) => i.path)).toEqual(paths)
  })

  it('accepts a name of exactly 100 characters', () => {
    const { db } = setup()
    const name = 'x'.repeat(100)
    expect(addPerson(db, { email: 'a@x.org', name, role: 'viewer' }).name).toBe(name)
  })
})

describe('listPeople', () => {
  it('orders by email and maps to PersonRow', () => {
    const { db } = setup()
    addPerson(db, { email: 'zed@x.org', role: 'viewer' })
    addPerson(db, { email: 'bob@x.org', role: 'admin' })
    const people = listPeople(db)
    expect(people.map((p) => p.email)).toEqual(['admin@example.org', 'bob@x.org', 'zed@x.org'])
    expect(Object.keys(people[0]!).sort()).toEqual(
      ['created_at', 'email', 'email_verified', 'id', 'name', 'role'].sort()
    )
  })
})

describe('updatePerson', () => {
  it('renames and promotes', () => {
    const { db, admin } = setup()
    const viewer = addPerson(db, { email: 'v@x.org', role: 'viewer' })
    const updated = updatePerson(db, admin.id, viewer.id, { name: 'Vee', role: 'admin' })
    expect(updated).toMatchObject({ id: viewer.id, name: 'Vee', role: 'admin' })
    expect(listPeople(db).find((p) => p.id === viewer.id)?.role).toBe('admin')
  })

  it('demotes another admin while one remains', () => {
    const { db, admin } = setup()
    const other = addPerson(db, { email: 'o@x.org', role: 'admin' })
    expect(updatePerson(db, admin.id, other.id, { role: 'viewer' }).role).toBe('viewer')
  })

  it('refuses to demote yourself', () => {
    const { db, admin } = setup()
    addPerson(db, { email: 'o@x.org', role: 'admin' })
    expect(failure(() => updatePerson(db, admin.id, admin.id, { role: 'viewer' }))).toMatchObject({
      statusCode: 409,
      code: 'conflict',
      message: 'You cannot remove your own admin access.',
    })
  })

  it('refuses to demote the last admin', () => {
    const { db } = setup()
    const actor = addPerson(db, { email: 'v@x.org', role: 'viewer' })
    const [onlyAdmin] = listPeople(db).filter((p) => p.role === 'admin')
    expect(
      failure(() => updatePerson(db, actor.id, onlyAdmin!.id, { role: 'viewer' }))
    ).toMatchObject({ statusCode: 409, message: 'There must be at least one admin.' })
  })

  it('lets you rename yourself and keep your role', () => {
    const { db, admin } = setup()
    expect(updatePerson(db, admin.id, admin.id, { name: 'Boss', role: 'admin' })).toMatchObject({
      name: 'Boss',
      role: 'admin',
    })
  })

  it('answers 404 for an unknown id', () => {
    const { db, admin } = setup()
    expect(failure(() => updatePerson(db, admin.id, 'nobody', { name: 'x' }))).toMatchObject({
      statusCode: 404,
      code: 'not_found',
    })
  })

  it('rejects an email change and a bad role with 422', () => {
    expect(failure(() => parsePersonPatch({ email: 'b@x.org' })).issues).toEqual([
      { path: 'email', message: 'is not a field of this request' },
    ])
    expect(failure(() => parsePersonPatch({ role: 'root' })).issues.map((i) => i.path)).toEqual([
      'role',
    ])
    expect(parsePersonPatch({})).toEqual({})
  })
})

describe('removePerson', () => {
  it('removes a person and their sessions with them', () => {
    const { db, sqlite, admin } = setup()
    const viewer = addPerson(db, { email: 'v@x.org', role: 'viewer' })
    addSession(db, viewer.id)
    addSession(db, admin.id)
    removePerson(db, admin.id, viewer.id)
    expect(listPeople(db).map((p) => p.email)).toEqual(['admin@example.org'])
    const sessions = sqlite.prepare('SELECT userId FROM session').all() as { userId: string }[]
    expect(sessions.map((s) => s.userId)).toEqual([admin.id])
  })

  it('refuses to remove yourself', () => {
    const { db, admin } = setup()
    addPerson(db, { email: 'o@x.org', role: 'admin' })
    expect(failure(() => removePerson(db, admin.id, admin.id))).toMatchObject({
      statusCode: 409,
      code: 'conflict',
      message: 'You cannot remove yourself.',
    })
  })

  it('refuses to remove the last admin', () => {
    const { db } = setup()
    const actor = addPerson(db, { email: 'v@x.org', role: 'viewer' })
    const onlyAdmin = listPeople(db).find((p) => p.role === 'admin')!
    expect(failure(() => removePerson(db, actor.id, onlyAdmin.id))).toMatchObject({
      statusCode: 409,
      message: 'There must be at least one admin.',
    })
  })

  it('removes another admin while one remains', () => {
    const { db, admin } = setup()
    const other = addPerson(db, { email: 'o@x.org', role: 'admin' })
    removePerson(db, admin.id, other.id)
    expect(db.select().from(schema.user).where(eq(schema.user.id, other.id)).get()).toBeUndefined()
  })

  it('answers 404 for an unknown id', () => {
    const { db, admin } = setup()
    expect(failure(() => removePerson(db, admin.id, 'nobody')).statusCode).toBe(404)
  })
})
