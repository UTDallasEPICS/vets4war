import { defineEventHandler } from 'h3'
import { easternToday } from '#shared/utils/dates'
import { db } from '../utils/db'
import { env } from '../utils/env'
import { getStatus } from '../utils/forecast/service'
import { requireUser } from '../utils/session'

// GET /api/status: who is signed in, what is being served, the current or last run.
export default defineEventHandler((event) => {
  const user = requireUser(event)
  return getStatus(db, { dataSourceKind: env.V4W_DATA_SOURCE, today: easternToday() }, user)
})
