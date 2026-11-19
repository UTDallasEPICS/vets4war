import { defineEventHandler, getRouterParam, readBody } from 'h3'
import { db } from '../../../utils/db'
import { requireAdmin } from '../../../utils/session'
import { parsePersonPatch, updatePerson } from '../../../utils/users'

// PATCH /api/admin/users/:id: rename or change the role.
export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event)
  const patch = parsePersonPatch(await readBody(event))
  return { user: updatePerson(db, admin.id, getRouterParam(event, 'id') ?? '', patch) }
})
