import { defineEventHandler, setResponseStatus } from 'h3'
import { db } from '../../../utils/db'
import { readJsonObject } from '../../../utils/http'
import { requireAdmin } from '../../../utils/session'
import { addPerson, parseNewPerson } from '../../../utils/users'

// POST /api/admin/users: give a person access (201), 409 when the address already has it.
export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const input = parseNewPerson(await readJsonObject(event))
  const user = addPerson(db, input)
  setResponseStatus(event, 201)
  return { user }
})
