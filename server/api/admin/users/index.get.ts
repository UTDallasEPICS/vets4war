import { defineEventHandler } from 'h3'
import { db } from '../../../utils/db'
import { requireAdmin } from '../../../utils/session'
import { listPeople } from '../../../utils/users'

// GET /api/admin/users: everyone who may sign in, ordered by email.
export default defineEventHandler((event) => {
  requireAdmin(event)
  return { users: listPeople(db) }
})
