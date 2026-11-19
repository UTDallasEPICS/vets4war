import { defineEventHandler, getRouterParam } from 'h3'
import { db } from '../../../utils/db'
import { requireAdmin } from '../../../utils/session'
import { removePerson } from '../../../utils/users'

// DELETE /api/admin/users/:id: remove a person and their sessions.
export default defineEventHandler((event) => {
  const admin = requireAdmin(event)
  removePerson(db, admin.id, getRouterParam(event, 'id') ?? '')
  return { ok: true }
})
