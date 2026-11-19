// People who may sign in, and their roles (PLAN.md section 8.5). Sign-up is off, so this
// is the only way in besides V4W_ADMIN_EMAILS. Each check runs in the same transaction
// as its write, so two admins acting at once cannot remove the last admin between them.
import { asc, count, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { PersonRow } from '#shared/types/api'
import { user } from '../db/schema'
import type { AppDb } from './db'
import { apiError, issuesFromZod, validationError } from './http'
import { toPersonRow } from './mappers'

export type Role = 'viewer' | 'admin'

const MAX_NAME = 100
const LAST_ADMIN = 'There must be at least one admin.'

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'must be an email address' }))
const name = z
  .string()
  .trim()
  .min(1, { message: 'must not be empty' })
  .max(MAX_NAME, { message: `must be at most ${MAX_NAME} characters` })
const role = z.enum(['viewer', 'admin'], { message: 'must be viewer or admin' })

const newPersonSchema = z.object({ email, name: name.optional(), role })
const personPatchSchema = z.strictObject({ name: name.optional(), role: role.optional() })

export interface NewPerson {
  email: string
  name?: string
  role: Role
}
export interface PersonPatch {
  name?: string
  role?: Role
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {})
  if (!result.success) throw validationError(issuesFromZod(result.error))
  return result.data
}

// The JSON body of POST /api/admin/users, or 422.
export function parseNewPerson(body: unknown): NewPerson {
  return parse(newPersonSchema, body)
}

// The JSON body of PATCH /api/admin/users/:id, or 422 (email cannot be changed).
export function parsePersonPatch(body: unknown): PersonPatch {
  return parse(personPatchSchema, body)
}

type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0]

function find(tx: Tx, id: string) {
  const row = tx.select().from(user).where(eq(user.id, id)).get()
  if (!row) throw apiError(404, 'not_found', 'No person with this id.')
  return row
}

function adminCount(tx: Tx): number {
  return tx.select({ n: count() }).from(user).where(eq(user.role, 'admin')).get()?.n ?? 0
}

export function listPeople(db: AppDb): PersonRow[] {
  return db.select().from(user).orderBy(asc(user.email)).all().map(toPersonRow)
}

// The address is stored trimmed and lower-cased; the name defaults to the part before @.
export function addPerson(db: AppDb, input: NewPerson): PersonRow {
  const person = parseNewPerson(input)
  const displayName = person.name ?? parse(name, person.email.split('@')[0])
  return db.transaction((tx) => {
    const existing = tx.select({ id: user.id }).from(user).where(eq(user.email, person.email)).get()
    if (existing) throw apiError(409, 'conflict', `${person.email} already has access.`)
    const row = tx
      .insert(user)
      .values({ email: person.email, name: displayName, role: person.role, emailVerified: false })
      .returning()
      .get()
    return toPersonRow(row)
  })
}

// Rename and/or change the role. Nobody can demote themselves, and the last admin
// stays an admin.
export function updatePerson(
  db: AppDb,
  actorId: string,
  id: string,
  patch: PersonPatch
): PersonRow {
  const change = parsePersonPatch(patch)
  return db.transaction((tx) => {
    const target = find(tx, id)
    if (change.role === 'viewer' && target.role === 'admin') {
      if (target.id === actorId) {
        throw apiError(409, 'conflict', 'You cannot remove your own admin access.')
      }
      if (adminCount(tx) <= 1) throw apiError(409, 'conflict', LAST_ADMIN)
    }
    if (change.name === undefined && change.role === undefined) return toPersonRow(target)
    const row = tx
      .update(user)
      .set({ ...change, updatedAt: new Date() })
      .where(eq(user.id, id))
      .returning()
      .get()
    return toPersonRow(row ?? target)
  })
}

// Removes the person; their sessions and accounts go with them (foreign-key cascade).
export function removePerson(db: AppDb, actorId: string, id: string): void {
  db.transaction((tx) => {
    const target = find(tx, id)
    if (target.id === actorId) throw apiError(409, 'conflict', 'You cannot remove yourself.')
    if (target.role === 'admin' && adminCount(tx) <= 1) {
      throw apiError(409, 'conflict', LAST_ADMIN)
    }
    tx.delete(user).where(eq(user.id, id)).run()
  })
}
