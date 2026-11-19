import { defineEventHandler, readBody } from 'h3'
import { easternToday } from '#shared/utils/dates'
import { db } from '../utils/db'
import { env } from '../utils/env'
import { postPlanned } from '../utils/forecast/service'
import { requireUser } from '../utils/session'

// POST /api/planned: a supervisor's roster judged against the forecast (PLAN.md 8.2).
export default defineEventHandler(async (event) => {
  requireUser(event)
  const body: unknown = await readBody(event)
  return postPlanned(db, { dataSourceKind: env.V4W_DATA_SOURCE, today: easternToday() }, body)
})
